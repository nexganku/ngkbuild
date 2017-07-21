/**
 * Context that will be passed to the task function during execution.
 */
export interface TaskContext {
    /** Additional task dependencies discovered during execution. */
    readonly additionalDeps: string[];
    /** Task output */
    readonly output: Buffer[];
}

/**
 * Function that runs a task.
 */
export type TaskFunction = (ctx: TaskContext) => (Promise<void> | void);

/**
 * Represents a task.
 */
export interface Task {
    /** Task inputs. */
    inputs: string[];
    /** Task function. */
    fn: TaskFunction;
    /** Task outputs. */
    outputs: string[];
    /** Task key. */
    key: string;
    /** Task description. Default: the task key. */
    description?: string;
}
