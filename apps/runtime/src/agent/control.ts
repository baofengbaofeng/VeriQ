import { readFile, writeFile, unlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { connect } from 'node:net';
import { AttemptBroker } from '../execution/broker.ts';
export async function serveAgentControl(root: string, stop: () => void) {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const broker = new AttemptBroker(join(root, 'agent.sock'), async (message) => { if (message.type === 'stop')
        stop();
    else if (message.type !== 'status')
        throw new Error('INVALID_OPERATION'); return { running: true, pid: process.pid }; });
    // The profile's live-owner lock is held before this stale socket can be removed.
    await unlink(broker.path).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT')
        throw e; });
    await broker.open();
    await writeFile(join(root, 'agent-control.json'), JSON.stringify({ socket: broker.path, nonce: broker.nonce }), { mode: 0o600, flush: true });
    return async () => { await broker.close(); await unlink(join(root, 'agent-control.json')); };
}
export async function agentControl(root: string, type: 'stop' | 'status') {
    const config = JSON.parse(await readFile(join(root, 'agent-control.json'), 'utf8')) as {
        socket: string;
        nonce: string;
    };
    return new Promise<{
        running: boolean;
        pid: number;
    }>((resolve, reject) => {
        const socket = connect(config.socket);
        let data = '';
        socket.on('connect', () => socket.write(JSON.stringify({ type, nonce: config.nonce }) + '\n'));
        socket.on('error', () => reject(new Error('AGENT_UNAVAILABLE')));
        socket.setTimeout(5000, () => { socket.destroy(); reject(new Error('AGENT_UNAVAILABLE')); });
        socket.on('data', chunk => { data += chunk.toString(); if (data.length > 65536) {
            socket.destroy();
            reject(new Error('INVALID_AGENT_RESPONSE'));
        }
        else if (data.includes('\n')) {
            socket.end();
            const reply = JSON.parse(data);
            if (reply.ok)
                resolve(reply.value);
            else
                reject(new Error('AGENT_UNAVAILABLE'));
        } });
    });
}
