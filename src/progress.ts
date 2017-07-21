/**
 * @module
 * Console status.
 */
import readline = require('readline');
import tty = require('tty');

/**
 * Console progress status.
 */
export interface Progress {
    status: string;
    /** Write chunk to console. */
    write(chunk: Buffer | string): void;
    /** Renders status. */
    render(): void;
    /** Un-renders status by printing a newline. */
    unrender(): void;
}

class ConsoleProgress implements Progress {
    status: string;
    private readonly stream: tty.WriteStream;
    private rendered: boolean;

    constructor(stream: tty.WriteStream) {
        this.status = '';
        this.stream = stream;
        this.rendered = false;
    }

    write(chunk: Buffer | string): void {
        this.unrender();
        this.stream.write(chunk);
    }

    render(): void {
        if (this.rendered)
            readline.cursorTo(this.stream, 0);
        this.stream.write(truncateString(this.status, this.stream.columns));
        if (this.rendered)
            readline.clearLine(this.stream, 1);
        this.rendered = true;
    }

    unrender(): void {
        if (this.rendered) {
            this.stream.write('\n');
            this.rendered = false;
        }
    }
}

/**
 * Create status.
 */
export function createProgress(stream?: NodeJS.WritableStream): Progress {
    if (!stream)
        stream = process.stdout;
    return new ConsoleProgress(stream as tty.WriteStream);
}

function truncateString(x: string, len: number): string {
    if (x.length <= len)
        return x;
    else if (len <= 3)
        return x.substr(0, len);
    else
        return `${x.substr(0, len - 3)}...`;
}
