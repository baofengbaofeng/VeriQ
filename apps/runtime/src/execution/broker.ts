import { createServer, type Server, type Socket } from 'node:net';
import { chmod, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
/** Private per-Attempt Unix socket. No device credential is sent to this endpoint. */
export class AttemptBroker {
    readonly nonce = randomBytes(32).toString('hex');
    private server: Server | undefined;
    private sockets = new Set<Socket>();
    constructor(readonly path: string, private receive: (message: Record<string, unknown>) => Promise<unknown>) { }
    async open() {
        this.server = createServer(socket => {
            this.sockets.add(socket);
            socket.on('close', () => this.sockets.delete(socket));
            socket.on('error', () => { });
            let bytes = 0, buffer = '';
            let handled = false;
            socket.on('data', (chunk: Buffer) => {
                if (handled)
                    return;
                bytes += chunk.length;
                if (bytes > 65536) {
                    socket.destroy();
                    return;
                }
                buffer += chunk.toString();
                if (!buffer.includes('\n'))
                    return;
                handled = true;
                void (async () => {
                    try {
                        const message = JSON.parse(buffer.slice(0, buffer.indexOf('\n'))) as Record<string, unknown>;
                        if (message.nonce !== this.nonce)
                            throw new Error('IPC_UNAUTHORIZED');
                        const value = await this.receive(message);
                        socket.end(JSON.stringify({ ok: true, value }) + '\n');
                    }
                    catch {
                        socket.end(JSON.stringify({ ok: false, error: 'ATTEMPT_IPC_FAILED' }) + '\n');
                    }
                })();
            });
            socket.setTimeout(15000, () => socket.destroy());
        });
        await new Promise<void>((resolve, reject) => { this.server!.once('error', reject); this.server!.listen(this.path, resolve); });
        await chmod(this.path, 0o600);
    }
    async close() { for (const socket of this.sockets)
        socket.destroy(); if (this.server)
        await new Promise<void>(resolve => this.server!.close(() => resolve())); await unlink(this.path).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT')
        throw e; }); }
}
