/**
 * 本文件提供 Agent 本机控制通道，通过带 nonce 的 Unix 套接字查询状态或请求停止，完全不经过平台 HTTP。
 */
import { readFile, writeFile, unlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { connect } from 'node:net';
import { AttemptBroker } from '../execution/broker.ts';
/**
 * 公开函数 serveAgentControl 在配置根下打开带 nonce 的本机控制套接字，供同机 CLI 查询状态或请求停机。
 * 写入 agent-control.json 前先清除陈旧套接字；返回的关闭回调会拆除代理并删除控制描述文件。
 */
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
/**
 * 公开函数 agentControl 连接本机 agent-control.json 描述的套接字，发送 stop/status 并校验 nonce 与超时。
 * 连接失败、超时或非 ok 应答一律映射为 AGENT_UNAVAILABLE，避免把内部错误细节泄漏给调用方。
 */
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
