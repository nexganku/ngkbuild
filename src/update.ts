/**
 * @module
 * Incremental update implementation.
 */
import {
    CommandNode,
    Database,
    DbNode,
    FileNode,
    NodeType,
    statFile,
} from './db';
import {
    Progress,
} from './progress';
import {
    TaskContext,
} from './task';
import util = require('util');
import path = require('path');
import fs = require('fs-extra');

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
    /** Command nodes inside the graph */
    private commandNodes: Set<CommandNode>;

    constructor() {
        this.nodes = new Map();
        this.rootNodes = new Set();
        this.commandNodes = new Set();
    }

    /**
     * Returns true if the graph has root nodes (nodes with no incoming edges).
     */
    hasRootNodes(): boolean {
        return this.rootNodes.size > 0;
    }

    /**
     * Returns the number of command nodes.
     */
    getNumCommandNodes(): number {
        return this.commandNodes.size;
    }

    /**
     * Returns an iterator over the graph's root nodes.
     */
    getRootNodes(): IterableIterator<GraphNode> {
        return this.rootNodes.values();
    }

    getNode(dbNode: DbNode): GraphNode | undefined {
        return this.nodes.get(dbNode);
    }

    addNode(dbNode: DbNode): GraphNode {
        let node = this.nodes.get(dbNode);
        if (node)
            return node;
        node = new GraphNode(dbNode);
        this.nodes.set(dbNode, node);
        this.rootNodes.add(node);
        if (node.dbNode.t === NodeType.Command)
            this.commandNodes.add(node.dbNode);
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
        if (node.dbNode.t === NodeType.Command)
            this.commandNodes.delete(node.dbNode);
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

    addParentsFromGraphNode(srcNode: GraphNode): GraphNode {
        let node = this.nodes.get(srcNode.dbNode);
        if (node)
            return node; // subgraph already added
        node = this.addNode(srcNode.dbNode);
        for (const srcParent of srcNode.parents) {
            const parent = this.addParentsFromGraphNode(srcParent);
            this.addEdge(parent, node);
        }
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

    async update(outputs?: string[]): Promise<void> {
        for (const dbNode of this.db.updateNodes)
            this.graph.addSubgraphFromDatabase(this.db, dbNode);

        if (outputs) {
            const oldOutputs = outputs;
            outputs = [];
            for (const x of oldOutputs) {
                if (!x.endsWith(path.sep)) {
                    outputs.push(x);
                    continue;
                }

                for (const fileName of this.db.fileNodes.keys()) {
                    if (fileName.startsWith(x))
                        outputs.push(fileName);
                }
            }
            // construct a new graph that will only build `outputs` and its dependencies.
            const srcGraph = this.graph;
            this.graph = new Graph();
            for (const output of outputs) {
                const dbNode = this.db.getFileNode(output);
                if (!dbNode)
                    throw new Error(`not a file: ${output}`);
                const srcNode = srcGraph.getNode(dbNode);
                if (!srcNode)
                    continue; // file not marked for update
                this.graph.addParentsFromGraphNode(srcNode);
            }
        }

        const totalUpdates = this.graph.getNumCommandNodes();
        let numUpdated = 0;

        while (this.graph.hasRootNodes()) {
            this.fillUpWorkers();
            const result = await Promise.race(this.workers.values());
            if (result.status === 'success') {
                this.workers.delete(result.graphNode);
                this.printResult(result);
                const dbNode = result.graphNode.dbNode;
                if (dbNode.t === NodeType.Command) {
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
        if (graphNode.dbNode.t === NodeType.File)
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
            throw new Error('commandNode.fn is undefined, this should not happen. ' +
                            `key: ${commandNode.k}, description: ${commandNode.description}`);
        const ctx: TaskContext = {
            additionalDeps: [],
            output: [],
        };
        try {
            // Ensure output directories are created.
            // TODO: make this more efficient.
            for (const node of graphNode.children) {
                const dbNode = node.dbNode;
                if (dbNode.t !== 0)
                    continue;
                const dir = path.dirname(dbNode.k);
                if (dir)
                    await fs.mkdirp(dir);
            }

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
export function update(db: Database, maxWorkers: number, progress: Progress, outputs?: string[]): Promise<void> {
    const updater = new Updater(db, maxWorkers, progress);
    return updater.update(outputs);
}
