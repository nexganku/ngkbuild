/**
 * @module
 * Incremental update implementation.
 */
import {
    CommandNode,
    Database,
    DbNode,
    FileNode,
    statFile,
} from './db';
import {
    Progress,
} from './progress';
import {
    TaskContext,
} from './task';
import util = require('util');

class GraphNode {
    dbNode: DbNode;
    children: Set<GraphNode>; // outgoing edges
    parents: Set<GraphNode>; // incoming edges

    constructor(dbNode: DbNode) {
        this.dbNode = dbNode;
        this.children = new Set();
        this.parents = new Set();
    }
}

class Graph {
    /** Mapping from database nodes to graph nodes */
    private nodes: Map<DbNode, GraphNode>;
    /** Graph nodes with no incoming edges. */
    private rootNodes: Set<GraphNode>;

    constructor() {
        this.nodes = new Map();
        this.rootNodes = new Set();
    }

    /**
     * Returns true if the graph has root nodes (nodes with no incoming edges).
     */
    hasRootNodes(): boolean {
        return this.rootNodes.size > 0;
    }

    /**
     * Returns an iterator over the graph's root nodes.
     */
    getRootNodes(): IterableIterator<GraphNode> {
        return this.rootNodes.values();
    }

    addNode(dbNode: DbNode): GraphNode {
        let node = this.nodes.get(dbNode);
        if (node)
            return node;
        node = new GraphNode(dbNode);
        this.nodes.set(dbNode, node);
        this.rootNodes.add(node);
        return node;
    }

    addEdge(src: GraphNode, dst: GraphNode): void {
        src.children.add(dst);
        dst.parents.add(src);
        this.rootNodes.delete(dst);
    }

    deleteNode(node: GraphNode): void {
        if (node.parents.size)
            throw new Error('Node has parents');
        for (const dst of node.children) {
            dst.parents.delete(node);
            if (!dst.parents.size)
                this.rootNodes.add(dst);
        }
        this.nodes.delete(node.dbNode);
        this.rootNodes.delete(node);
    }

    /**
     * Add node and its children from database.
     */
    addSubgraphFromDatabase(db: Database, dbNode: DbNode, stack?: Set<DbNode>): GraphNode {
        let node = this.nodes.get(dbNode);
        if (node)
            return node; // subgraph rooted at node already added
        if (!stack)
            stack = new Set();
        if (stack.has(dbNode))
            throw new Error('circular dependency detected');
        stack.add(dbNode);
        node = this.addNode(dbNode);
        const dbChildren = db.getChildren(dbNode) || [];
        for (const dbChild of dbChildren) {
            const child = this.addSubgraphFromDatabase(db, dbChild, stack);
            db.markUpdate(child.dbNode);
            this.addEdge(node, child);
        }
        stack.delete(dbNode);
        return node;
    }
}

interface SuccessWorkerResult {
    status: 'success';
    output: Buffer[];
    graphNode: GraphNode;
}

interface FailureWorkerResult {
    status: 'failure';
    output: Buffer[];
    graphNode: GraphNode;
    error: any;
}

type WorkerResult = SuccessWorkerResult | FailureWorkerResult;

class Updater {
    private db: Database;
    private maxWorkers: number;
    private graph: Graph;
    private workers: Map<GraphNode, Promise<WorkerResult>>;
    private progress: Progress;

    constructor(db: Database, maxWorkers: number, progress: Progress) {
        this.db = db;
        this.maxWorkers = maxWorkers;
        this.graph = new Graph();
        this.workers = new Map();
        this.progress = progress;
    }

    async update(): Promise<void> {
        for (const dbNode of this.db.updateNodes)
            this.graph.addSubgraphFromDatabase(this.db, dbNode);

        const totalUpdates = this.db.commandUpdateNodes.size;
        let numUpdated = 0;

        while (this.graph.hasRootNodes()) {
            this.fillUpWorkers();
            const result = await Promise.race(this.workers.values());
            if (result.status === 'success') {
                this.workers.delete(result.graphNode);
                this.printResult(result);
                const dbNode = result.graphNode.dbNode;
                if (dbNode.t === 1) {
                    const description = dbNode.description || dbNode.k;
                    numUpdated++;
                    this.progress.status = `[${numUpdated}/${totalUpdates}] ${description}`;
                    this.progress.render();
                }
            } else {
                break;
            }
        }

        // We succeeded
        if (!this.graph.hasRootNodes()) {
            await this.db.commit();
            return;
        }

        // We failed
        const results = await Promise.all(this.workers.values());
        for (const result of results)
            this.printResult(result);

        await this.db.commit();
    }

    /**
     * Add as many workers as we can.
     */
    private fillUpWorkers(): void {
        while (this.graph.hasRootNodes() && this.workers.size < this.maxWorkers) {
            const graphNode = this.findAvailableGraphNode();
            if (!graphNode)
                break;

            this.workers.set(graphNode, this.updateNode(graphNode));
        }
    }

    /**
     * Find a graphNode that is a startNode but is not being processed.
     * Returns undefined if such graph node could not be found.
     */
    private findAvailableGraphNode(): GraphNode | undefined {
        for (const graphNode of this.graph.getRootNodes())
            if (!this.workers.has(graphNode))
                return graphNode;
        return undefined;
    }

    private async updateNode(graphNode: GraphNode): Promise<WorkerResult> {
        let result: WorkerResult;
        if (graphNode.dbNode.t === 0)
            result = await this.updateFileNode(graphNode, graphNode.dbNode);
        else
            result = await this.updateCommandNode(graphNode, graphNode.dbNode);
        if (result.status === 'success') {
            this.db.unmarkUpdate(graphNode.dbNode);
            this.graph.deleteNode(graphNode);
        }
        return result;
    }

    private async updateFileNode(graphNode: GraphNode, fileNode: FileNode): Promise<WorkerResult> {
        [fileNode.m, fileNode.s] = await statFile(fileNode.k);
        return {
            graphNode,
            output: [],
            status: 'success',
        };
    }

    private async updateCommandNode(graphNode: GraphNode, commandNode: CommandNode): Promise<WorkerResult> {
        const fn = commandNode.fn;
        if (!fn)
            throw new Error('commandNode.fn is undefined, this should not happen');
        const ctx: TaskContext = {
            additionalDeps: [],
            output: [],
        };
        try {
            const ret = fn(ctx);
            if (ret)
                await ret;
        } catch (error) {
            return {
                error,
                graphNode,
                output: ctx.output,
                status: 'failure',
            };
        }

        for (const filename of ctx.additionalDeps) {
            let node = this.db.fileNodes.get(filename);
            // If node is active, that means that its mtime was/will be updated in this build,
            // so everything is OK.
            if (node && node.active)
                continue;
            node = this.db.addFileNode(filename);
            this.graph.addSubgraphFromDatabase(this.db, node);
        }

        commandNode.d = ctx.additionalDeps;

        return {
            graphNode,
            output: ctx.output,
            status: 'success',
        };
    }

    private printResult(result: WorkerResult): void {
        if (result.output.length) {
            for (const output of result.output)
                this.progress.write(output);
        }
        if (result.status === 'failure')
            this.progress.write(util.inspect(result.error) + '\n');
    }
}

/**
 * Update
 */
export function update(db: Database, maxWorkers: number, progress: Progress): Promise<void> {
    const updater = new Updater(db, maxWorkers, progress);
    return updater.update();
}
