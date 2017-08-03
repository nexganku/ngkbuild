/**
 * @module
 * ngkbuild Public API
 */
import {
    CommandTask,
    commandTaskToTask,
} from './cmdtask';
import {
    Database,
    readDatabase,
    scan,
} from './db';
import {
    createProgress,
} from './progress';
import {
    Task,
} from './task';
import {
    update,
} from './update';
import fs = require('fs');
import os = require('os');

/**
 * Options for {@link Build#run}
 */
export interface RunOptions {
    /**
     * Maximum number of file descriptors that can be consumed concurrently at any time during filesystem scanning.
     * Default: `100`.
     */
    maxFds?: number;

    /**
     * Maximum number of tasks that can be run concurrently at any time.
     * Default: number of CPU cores in the system.
     */
    maxWorkers?: number;

    /**
     * If provided, only these outputs (and their dependencies) will be rebuilt if outdated.
     */
    outputs?: string[];
}

/**
 * Represents a build to be done.
 */
export interface Builder {
    /** Add a task to the build. */
    addTask(task: Task | CommandTask): void;
    /** Run the build. */
    run(options?: RunOptions): Promise<void>;
}

class BuilderImpl implements Builder {
    private db: Database;

    constructor(db: Database) {
        this.db = db;
    }

    addTask(task: Task | CommandTask): void {
        if (isCommandTask(task))
            task = commandTaskToTask(task);
        this.db.addTask(task);
    }

    async run(options?: RunOptions): Promise<void> {
        if (!options)
            options = {};
        const progress = createProgress();
        await scan(this.db, options.maxFds || 100);
        await update(this.db, options.maxWorkers || os.cpus().length, progress, options.outputs);
        progress.unrender();
    }
}

/**
 * Construct a new build context.
 *
 * @param dbFilename the filename, or `.ngkbuild.json` if not provided.
 */
export async function newBuilder(dbFilename: string = '.ngkbuild.json'): Promise<Builder> {
    const db = (await fileExists(dbFilename)) ? (await readDatabase(dbFilename)) : new Database(undefined, dbFilename);
    return new BuilderImpl(db);
}

function fileExists(filename: string): Promise<boolean> {
    return new Promise<boolean>(resolve => {
        fs.access(filename, fs.constants.F_OK, err => resolve(!err));
    });
}

function isCommandTask(x: any): x is CommandTask {
    return Array.isArray(x.command);
}

export {
    Task,
} from './task';
export {
    CommandTask,
    commandTaskToTask,
} from './cmdtask';
