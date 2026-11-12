/** Explicit upload only: enrolled device origin/credential, never bundle routing metadata. */
import { LocalStore } from './store.ts';
import { LocalReports } from './reports.ts';
import { controlOrigin, type DeviceConfig } from '../enrollment.ts';
import { validateSchema, type PlatformComponents } from '@veriq/contracts';
type Receipt = PlatformComponents['schemas']['ImportDTO'];
export async function uploadOffline(root: string, runId: string, config: Pick<DeviceConfig, 'server' | 'workspaceId' | 'deviceToken'>, signal?: AbortSignal): Promise<Receipt> {
    const store = await LocalStore.open(root);
    try {
        const result = store.result(config.workspaceId, runId);
        if (store.active()?.runId === runId)
            throw new Error('LOCAL_RUN_UNFINISHED');
        if (validateSchema('OfflineResultV1', result).length)
            throw new Error('INVALID_OFFLINE_RESULT');
        const origin = controlOrigin(config.server), base = `/internal/v1/workspaces/${config.workspaceId}`;
        const request = async (path: string, method: string, body: BodyInit, contentType: string) => {
            if (!path.startsWith(base + '/') || new URL(path, origin).origin !== origin)
                throw new Error('UPLOAD_ORIGIN_MISMATCH');
            const response = await fetch(origin + path, { method, body, redirect: 'error', credentials: 'omit', signal: AbortSignal.any([AbortSignal.timeout(60000), ...(signal ? [signal] : [])]), headers: { Authorization: `Bearer ${config.deviceToken}`, 'Content-Type': contentType, 'Idempotency-Key': 'offline_' + runId } });
            const chunks: Uint8Array[] = [];
            let size = 0;
            if (response.body)
                for await (const chunk of response.body) {
                    size += chunk.length;
                    if (size > 65536)
                        throw new Error('UPLOAD_RESPONSE_LIMIT');
                    chunks.push(chunk);
                }
            if (response.status === 422) {
                let code: unknown;
                try {
                    code = (JSON.parse(Buffer.concat(chunks).toString()) as {
                        code?: unknown;
                    }).code;
                }
                catch { /* Unstructured server error remains UPLOAD_FAILED. */ }
                if (code === 'OFFLINE_VARIANT_FACTS_REQUIRED')
                    throw new Error(code);
            }
            if (!response.ok)
                throw new Error(response.status === 401 || response.status === 403 ? 'UPLOAD_UNAUTHORIZED' : response.status === 409 ? 'UPLOAD_CONFLICT' : 'UPLOAD_FAILED');
            return JSON.parse(Buffer.concat(chunks).toString()).data as unknown;
        };
        const reports = new LocalReports(root, workspace => workspace === config.workspaceId);
        for (const attempt of result.attempts)
            for (const file of attempt.artifacts) {
                if (!file.artifactId || !file.kind)
                    throw new Error('INVALID_OFFLINE_ARTIFACT');
                const bytes = await reports.readRaw(config.workspaceId, runId, attempt.attemptId, file.artifactId);
                const reserved = await request(base + '/result-import-uploads', 'POST', JSON.stringify({ bundleId: result.bundleId, localRunId: runId, attemptId: attempt.attemptId, file }), 'application/json') as {
                    id: string;
                    uploadUrl: string;
                };
                if (!/^[0-9a-f-]{36}$/i.test(reserved.id) || reserved.uploadUrl !== base + '/result-import-uploads/' + reserved.id)
                    throw new Error('UPLOAD_ORIGIN_MISMATCH');
                for (let offset = 0; offset < Math.max(1, bytes.length); offset += 1024 * 1024) {
                    const chunk = bytes.subarray(offset, offset + 1024 * 1024);
                    const reply = await request(reserved.uploadUrl + '?offset=' + offset, 'PUT', new Uint8Array(chunk), 'application/octet-stream') as {
                        receivedBytes: number;
                        complete: boolean;
                    };
                    if (reply.receivedBytes < offset + chunk.length || reply.receivedBytes > bytes.length || reply.complete !== (reply.receivedBytes === bytes.length))
                        throw new Error('INVALID_UPLOAD_ACK');
                }
            }
        const receipt = await request(base + '/result-imports', 'POST', JSON.stringify(result), 'application/json') as Receipt;
        if (receipt.localRunId !== runId || receipt.source !== 'OFFLINE_IMPORT' || receipt.officialGatePassed !== false || ![receipt.id, receipt.runId].every(id => /^[0-9a-f-]{36}$/i.test(id)))
            throw new Error('INVALID_IMPORT_RECEIPT');
        store.uploaded(config.workspaceId, runId, receipt);
        return receipt;
    }
    catch (error) {
        const failure = error instanceof Error && /^[A-Z_]{1,80}$/.test(error.message) ? error.message : 'UPLOAD_FAILED';
        // Scope mismatch must not disclose or update another Workspace's history.
        if (failure !== 'LOCAL_RUN_NOT_FOUND')
            store.uploadFailed(config.workspaceId, runId, failure);
        throw new Error(failure);
    }
    finally {
        store.close();
    }
}
