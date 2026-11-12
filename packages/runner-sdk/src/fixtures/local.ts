/**
 * 本文件提供本机开发用凭证提供者：按 Attempt 钉选版本解析密钥：不假装成生产保险库实现（local/DUPLICATE_LOCAL_CREDENTIAL）。
 */

import type { JsonValue } from "@veriq/contracts";
import type { CredentialProvider } from "../register-case.js";
type Reference = { workspaceId: string; secretRef: string; versionId: string };
/**
 * 公开类 LocalCredentialProvider 包装本机 SecretResolver：供开发执行解析钉选密钥。
 */
export class LocalCredentialProvider implements CredentialProvider {
    private readonly records = new Map<string, JsonValue>();
    constructor(records: (Reference & { value: JsonValue })[]) {
        for (const record of records) {
            const key = this.key(record);
            if (this.records.has(key)) throw new Error("DUPLICATE_LOCAL_CREDENTIAL");
            this.records.set(key, structuredClone(record.value));
        }
    }
    private key(reference: Reference): string {
        return JSON.stringify([
            reference.workspaceId,
            reference.secretRef,
            reference.versionId,
        ]);
    }
    /**
     * 公开方法 resolve 按钉选引用解析本机密钥：忽略 signal 以外的旁路缓存：缺失即失败（resolve/CANCELLED）。
     */
    async resolve(reference: Reference, signal: AbortSignal): Promise<JsonValue> {
        if (signal.aborted) throw new Error("CANCELLED");
        const value = this.records.get(this.key(reference));
        if (value === undefined) throw new Error("LOCAL_CREDENTIAL_REQUIRED");
        return structuredClone(value);
    }
}
