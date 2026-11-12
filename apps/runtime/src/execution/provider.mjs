/**
 * 本文件是受信任的工作进程注入模块：由监督器复制进 Attempt 工作区：创建执行上下文且永不由 DSL 选取（provider）。
 */
import { join } from 'node:path';
// Trusted worker module copied by the supervisor, never selected by DSL or a bundle.
import { readFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { createHttpLifecycle } from '@veriq/runner-sdk';
const settings = JSON.parse(await readFile(new URL('./invocation.json', import.meta.url), 'utf8'));
/**
 * 公开函数 contact 与 Attempt 私有代理进行握手：确认工作进程控制通道可用后才继续执行用例（contact）。
 */
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
/**
 * 公开函数 createExecutionContext 为生成代码注入执行上下文：凭证与证据策略由监督器装配：DSL 不能改写该注入边界。
 */
export async function createExecutionContext() {
    const controller = new AbortController();
    const timer = setInterval(() => contact({ type: 'status' }).then(value => { if (value.cancelled)
        controller.abort(); }).catch(() => controller.abort()), 100);
    timer.unref();
    const secrets = new Map();
    const execution = JSON.parse(await readFile(new URL('./execution.json', import.meta.url), 'utf8'));
    return { execution, finalizeExecution: async context => {
        try {
            // 可信取消后不得再开可选截图；上下文关闭仍是物理完成与重试观察的必要条件。
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
