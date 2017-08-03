import fs = require('fs-extra');
import {
    Task,
    TaskFunction,
} from './task';

// Node types
// The key names are very short to reduce database file size.

/**
 * Node types.
 */
export enum NodeType {
    File,
    Command,
}

/**
 * Node representing a file.
 */
export interface FileNode {
    t: NodeType.File;
    /** Node key: File path. */
    k: string;
    /** Last mtime, negative if the file does not exist or last mtime not available. */
    m: number;
    /** Last size, negative if the file does not exist. */
    s: number;
    /** Command node which generates this file. */
    commandNode?: CommandNode;
    /** Node was referenced. */
    active: boolean;
    /** True if the node must be updated. */
    u: boolean;
}

/**
 * Constructs a new {@link FileNode}
 */
export function createFileNode(filename: string): FileNode {
    return {
        active: true,
        k: filename,
        m: -1,
        s: -1,
        t: NodeType.File,
        u: true,
    };
}

/**
 * Serializes `fileNode` into a JSON object string.
 */
export function fileNodeToJson(fileNode: FileNode): string {
    return JSON.stringify({
        k: fileNode.k,
        m: fileNode.m,
        s: fileNode.s,
        t: fileNode.t,
        u: fileNode.u,
    });
}

/**
 * Node representing a command.
 */
export interface CommandNode {
    t: NodeType.Command;
    /** Node key. */
    k: string;
    /** Additional file deps. */
    d: string[];
    /** Command function */
    fn?: TaskFunction;
    /** True if the node must be updated. */
    u: boolean;
    description?: string;
}

/**
 * Constructs a new {@link CommandNode}.
 */
export function createCommandNode(key: string, fn: TaskFunction): CommandNode {
    return {
        d: [],
        fn,
        k: key,
        t: NodeType.Command,
        u: false,
    };
}

/**
 * Serializes `commandNode` into a JSON object string.
 */
function commandNodeToJson(commandNode: CommandNode): string {
    return JSON.stringify({
        d: commandNode.d,
        k: commandNode.k,
        t: commandNode.t,
        u: commandNode.u,
    });
}

/**
 * Database Node.
 */
export type DbNode = FileNode | CommandNode;

/**
 * Database for persisting data between build runs.
 */
export class Database {
    readonly fileNodes: Map<string, FileNode>;
    readonly commandNodes: Map<string, CommandNode>;
    readonly updateNodes: Set<DbNode>;
    readonly edges: Map<DbNode, Set<DbNode>>;
    private filename?: string;

    constructor(nodes?: Iterable<DbNode>, filename?: string) {
        if (!nodes)
            nodes = new Set<DbNode>();
        this.filename = filename;
        this.fileNodes = new Map();
        this.commandNodes = new Map();
        this.updateNodes = new Set();
        this.edges = new Map();
        for (const node of nodes) {
            if (node.t === NodeType.File)
                this.fileNodes.set(node.k, node);
            else
                this.commandNodes.set(node.k, node);
        }
    }

    async commit(): Promise<void> {
        if (!this.filename)
            return;
        const chunks: string[] = [];
        let isFirst = true;
        chunks.push('[');
        for (const node of this.fileNodes.values()) {
            if (!node.active || node.m < 0)
                continue; // don't bother writing file nodes with no mtime or not active
            chunks.push((isFirst ? '' : ',\n') + fileNodeToJson(node));
            isFirst = false;
        }
        for (const node of this.commandNodes.values()) {
            if (!node.fn)
                continue;
            chunks.push((isFirst ? '' : ',\n') + commandNodeToJson(node));
            isFirst = false;
        }
        chunks.push(']\n');
        await fs.writeFile(this.filename, chunks.join(''));
    }

    markUpdate(node: DbNode): void {
        node.u = true;
        this.updateNodes.add(node);
    }

    unmarkUpdate(node: DbNode): void {
        node.u = false;
        this.updateNodes.delete(node);
    }

    getFileNode(filename: string): FileNode | undefined {
        const node = this.fileNodes.get(filename);
        return node && node.active ? node : undefined;
    }

    addFileNode(filename: string): FileNode {
        let node = this.fileNodes.get(filename);
        if (!node) {
            node = createFileNode(filename);
            this.fileNodes.set(filename, node);
            this.markUpdate(node);
        } else {
            node.active = true;
            if (node.u)
                this.markUpdate(node);
        }
        return node;
    }

    addCommandNode(key: string, fn: TaskFunction): CommandNode {
        let node = this.commandNodes.get(key);
        if (!node) {
            node = createCommandNode(key, fn);
            this.commandNodes.set(key, node);
            this.markUpdate(node);
        } else {
            node.fn = fn;
            if (node.u)
                this.markUpdate(node);
        }
        return node;
    }

    addEdge(src: DbNode, dst: DbNode): void {
        let dstSet = this.edges.get(src);
        if (!dstSet) {
            dstSet = new Set();
            this.edges.set(src, dstSet);
        }
        dstSet.add(dst);
    }

    getChildren(src: DbNode): Set<DbNode> | undefined {
        return this.edges.get(src);
    }

    addTask(task: Task): void {
        const commandNode = this.addCommandNode(task.key, task.fn);
        commandNode.description = task.description;

        for (const name of task.inputs) {
            const inputNode = this.addFileNode(name);
            this.addEdge(inputNode, commandNode);
        }

        for (const name of task.outputs) {
            const outputNode = this.addFileNode(name);

            if (outputNode.commandNode)
                throw new Error(`output file ${name} is already associated with command ${outputNode.commandNode.k}`);
            outputNode.commandNode = commandNode;

            // If output file was modified, we need to re-run the command that builds it.
            if (outputNode.u)
                this.markUpdate(commandNode);

            this.addEdge(commandNode, outputNode);
        }

        // Reuse recorded commandnode deps
        for (const name of commandNode.d) {
            const inputNode = this.addFileNode(name);
            this.addEdge(inputNode, commandNode);
        }
    }
}

/**
 * Read database from file.
 */
export async function readDatabase(filename: string): Promise<Database> {
    const contents = await fs.readFile(filename, 'utf-8');
    const nodes = JSON.parse(contents);
    const db = new Database(nodes, filename);
    return db;
}

/**
 * Scan filesystem for changes.
 */
export async function scan(db: Database, maxFds: number): Promise<void> {
    const iter = db.fileNodes.values();

    const workers = [];
    const numWorkers = Math.min(maxFds, db.fileNodes.size);
    for (let i = 0; i < numWorkers; i++)
        workers.push(scanWorker());

    await Promise.all(workers);

    async function scanWorker(): Promise<void> {
        while (true) {
            const item = iter.next();
            if (item.done)
                return;
            if (!item.value.active)
                continue; // inactive node that is not referenced by a task.
            if (db.updateNodes.has(item.value))
                continue; // node is already marked for update, no need to check mtime
            const node = item.value;
            const [mtime, size] = await statFile(node.k);
            if (mtime !== node.m || size !== node.s) {
                db.markUpdate(node);

                // If file node was modified, the command that generated it must be re-run.
                if (node.t === 0 && node.commandNode)
                    db.markUpdate(node.commandNode);
            }
        }
    }
}

/**
 * Returns the mtime and size of the file.
 */
export async function statFile(filename: string): Promise<[number, number]> {
    let stats;
    try {
        stats = await fs.stat(filename);
    } catch (e) {
        return [-1, -1];
    }
    return [stats.mtime.getTime(), stats.size];
}
