/**
 * @module
 * Implements Tasks that runs commands.
 */
import {
    Task,
} from './task';
import childProcess = require('child_process');
import crypto = require('crypto');

/**
 * Represents a task that runs command(s) in sequence.
 */
export interface CommandTask {
    inputs: string[];
    command: string[];
    outputs: string[];
    description?: string;
}

/**
 * Converts a command task into a task.
 */
export function commandTaskToTask(commandTask: CommandTask): Task {
    const command = commandTask.command;
    const hash = crypto.createHash('md5');
    hash.update(JSON.stringify(command));

    return {
        description: commandTask.description || command.map(quote).join(' '),
        fn: ctx => runCommand(command, ctx.output),
        inputs: commandTask.inputs,
        key: hash.digest('hex'),
        outputs: commandTask.outputs,
    };
}

function runCommand(command: string[], output: Buffer[]): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const cmdFile = command[0];
        const cmdArgs = command.slice(1);
        const cp = childProcess.spawn(cmdFile, cmdArgs, {
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        cp.on('error', e => {
            reject(e);
        });
        cp.on('close', (code, signal) => {
            if (code === 0)
                return resolve();
            reject(new Error(`Command returned code ${code}, signal ${signal}`));
        });
        const chunkCallback = (chunk: string | Buffer) => {
            output.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
        };
        cp.stdout.on('data', chunkCallback);
        cp.stderr.on('data', chunkCallback);
    });
}

/**
 * Return a shell-escaped version of `x`
 */
function quote(x: string): string {
    if (!x.length)
        return '\'\'';
    else if (!/[^\w@%+=:,./-]/.test(x))
        return x;

    const y = x.replace(`'`, `'"'"'`);
    return `'${y}'`;
}
