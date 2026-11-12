/**
 * 本文件封装带设备令牌与围栏令牌的控制面传输：强制同源路径校验、限制二进制体大小，download 完成后核对内容 sha256。
 */
import { createHash } from 'node:crypto';
import { RuntimeError } from '../enrollment.ts';
import { DeviceSession } from './credentials.ts';
import type { PlatformComponents } from '@veriq/contracts';
type S = PlatformComponents['schemas'];
/**
 * 公开类型 Claim 即平台 ClaimDTO，包含 attempt、租约令牌、围栏令牌与过期时间，供执行路径与心跳共用。
 */
export type Claim = S['ClaimDTO'];
/**
 * 公开类型 Proof 只抽取 leaseToken 与 fencingToken，用于证据上传与内容下载时的 Attempt 级鉴权头。
 */
export type Proof = Pick<Claim, 'leaseToken' | 'fencingToken'>;
/**
 * 公开类 AgentClient 经 DeviceSession 发起控制面请求，强制同源路径并在二进制通道附带租约与围栏头。
 */
export class AgentClient {
    constructor(readonly session: DeviceSession) { }
    /**
     * 公开方法 request 在设备凭证队列中发起 JSON 控制请求，路径必须落在已注册控制 Origin 之内（withCredential/CONTROL_ORIGIN_MISMATCH）。
     */
    request<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
        return this.session.withCredential(config => this.session.client.request<T>(path, method, body, config.deviceToken, signal));
    }
    private path(path: string): string {
        const url = new URL(path, this.session.client.server);
        if (url.origin !== this.session.client.server || url.username || url.password || url.hash || path.startsWith('//') || (!path.startsWith('/') && !/^https?:\/\//.test(path)))
            throw new Error('CONTROL_ORIGIN_MISMATCH');
        return url.href;
    }
    /**
     * 公开方法 binary 以租约与围栏头读写有界二进制内容，禁止重定向与 Cookie，超额则取消流式读取（binary/CHUNK_TOO_LARGE）。
     */
    async binary(path: string, proof: Proof, signal: AbortSignal, bytes?: Uint8Array): Promise<Uint8Array> {
        const url = this.path(path);
        if (bytes && bytes.length > 1024 * 1024)
            throw new Error('CHUNK_TOO_LARGE');
        return this.session.withCredential(async (config) => {
            const response = await fetch(url, { method: bytes ? 'PUT' : 'GET', redirect: 'error', credentials: 'omit', signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]), headers: { Authorization: `Bearer ${config.deviceToken}`, 'X-VeriQ-Lease-Token': proof.leaseToken, 'X-VeriQ-Fencing-Token': String(proof.fencingToken), ...(bytes ? { 'Content-Type': 'application/octet-stream' } : {}) }, ...(bytes ? { body: Buffer.from(bytes) } : {}) });
            const reader = response.body?.getReader();
            const parts: Uint8Array[] = [];
            let size = 0;
            if (reader)
                while (true) {
                    const next = await reader.read();
                    if (next.done)
                        break;
                    size += next.value.length;
                    if (size > (bytes ? 65536 : 32 * 1024 * 1024)) {
                        await reader.cancel();
                        throw new Error('CONTENT_LIMIT');
                    }
                    parts.push(next.value);
                }
            if (!response.ok)
                throw new RuntimeError('CONTROL_REQUEST_FAILED', response.status);
            return Buffer.concat(parts);
        });
    }
    /**
     * 公开方法 download 拉取内容后强制比对 sha256，哈希不符立即失败，防止损坏或被调包的作业成员进入执行（download/CONTENT_HASH_MISMATCH）。
     */
    async download(path: string, hash: string, proof: Proof, signal: AbortSignal): Promise<Uint8Array> {
        const bytes = await this.binary(path, proof, signal);
        if (createHash('sha256').update(bytes).digest('hex') !== hash)
            throw new Error('CONTENT_HASH_MISMATCH');
        return bytes;
    }
}
