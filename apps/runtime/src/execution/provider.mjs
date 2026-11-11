import { join } from 'node:path';
// Trusted worker module copied by the supervisor, never selected by DSL or a bundle.
import { readFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { createHttpLifecycle } from '@veriq/runner-sdk';
const settings = JSON.parse(await readFile(new URL('./invocation.json', import.meta.url), 'utf8'));
export async function contact(message) {
    return new Promise((resolve, reject) => {
        const socket = connect(settings.socket);
        let buffer = '', bytes = 0;
        socket.on('connect', () => socket.write(JSON.stringify({ ...message, nonce: settings.nonce }) + '\n'));
        socket.on('error', () => reject(new Error('ATTEMPT_IPC_FAILED')));
        socket.setTimeout(15000, () => { socket.destroy(); reject(new Error('ATTEMPT_IPC_TIMEOUT')); });
        socket.on('data', chunk => { bytes += chunk.length; if (bytes > 65536) {
            socket.destroy();
            reject(new Error('IPC_RESPONSE_LIMIT'));
            return;
        } buffer += chunk.toString(); if (buffer.includes('\n')) {
            socket.end();
            const reply = JSON.parse(buffer.slice(0, buffer.indexOf('\n')));
            reply.ok ? resolve(reply.value) : reject(new Error('ATTEMPT_IPC_FAILED'));
        } });
        socket.on('end', () => { if (!buffer.includes('\n'))
            reject(new Error('ATTEMPT_IPC_CLOSED')); });
    });
}
export async function createExecutionContext() {
    const controller = new AbortController();
    const timer = setInterval(() => contact({ type: 'status' }).then(value => { if (value.cancelled)
        controller.abort(); }).catch(() => controller.abort()), 100);
    timer.unref();
    const secrets = new Map();
    const execution = JSON.parse(await readFile(new URL('./execution.json', import.meta.url), 'utf8'));
    return { execution, finalizeExecution: async context => {
        try {
            // Optional capture must not start after trusted cancellation. Context close
            // remains mandatory for physical completion and retry observation.
            const page = context.pages()[0];
            if (!controller.signal.aborted && page && !page.isClosed())
                await page.screenshot({path: join(settings.tmp, 'screenshot.png'), timeout:5000});
        } finally {
            await context.close();
        }
    }, signal: controller.signal, lifecycle: createHttpLifecycle(), credentials: { resolve: reference => { const key = JSON.stringify(reference); if (!secrets.has(key))
                secrets.set(key, contact({ type: 'credential', reference })); return secrets.get(key); } }, downloads: { directory: settings.downloads, maxBytes: settings.downloadLimit }, redact: value => value,
        onEvent: async (event) => { if (event.type === 'CASE_FINISHED')
            clearInterval(timer); await contact({ type: 'event', event: event.type === 'CASE_FINISHED' ? { type: event.type, result: { ...event.result, steps: [] } } : event }); }, restrictedEvidence: evidence => contact({ type: 'restricted', evidence }) };
}
