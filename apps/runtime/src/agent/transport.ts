import { createHash } from 'node:crypto';
import { RuntimeError } from '../enrollment.ts';
import { DeviceSession } from './credentials.ts';
import type { PlatformComponents } from '@veriq/contracts';
type S = PlatformComponents['schemas'];
export type Claim = S['ClaimDTO'];
export type Proof = Pick<Claim, 'leaseToken' | 'fencingToken'>;
export class AgentClient {
    constructor(readonly session: DeviceSession) { }
    request<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
        return this.session.withCredential(config => this.session.client.request<T>(path, method, body, config.deviceToken, signal));
    }
    private path(path: string): string {
        const url = new URL(path, this.session.client.server);
        if (url.origin !== this.session.client.server || url.username || url.password || url.hash || path.startsWith('//') || (!path.startsWith('/') && !/^https?:\/\//.test(path)))
            throw new Error('CONTROL_ORIGIN_MISMATCH');
        return url.href;
    }
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
    async download(path: string, hash: string, proof: Proof, signal: AbortSignal): Promise<Uint8Array> {
        const bytes = await this.binary(path, proof, signal);
        if (createHash('sha256').update(bytes).digest('hex') !== hash)
            throw new Error('CONTENT_HASH_MISMATCH');
        return bytes;
    }
}
