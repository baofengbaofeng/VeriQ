/**
 * 本文件提供 Attempt 钉选凭证的本机存储与解析：按不可变版本查找密钥：禁止回落到最新版本或跨工作区读取（store/INVALID_SECRET_REFERENCE）。
 */

import type { JsonValue } from "@veriq/contracts";
import { validateSchema } from "@veriq/contracts";
import { readPrivate, updatePrivate } from "../offline/config.ts";
/**
 * 公开类型 SecretReference 钉选 issuer/workspace/secretRef/versionId。
 * 四元组缺一不可。
 * 防止模糊解析到错误密钥。
 */
export type SecretReference = {
    issuerId: string;
    workspaceId: string;
    secretRef: string;
    versionId: string;
};
/**
 * 公开类型 SecretValue 即契约 JsonValue：表示本机保险库中的密钥载荷：不得写入日志（SecretValue/INVALID_SECRET_REFERENCE）。
 */
export type SecretValue = JsonValue;
function key(ref: SecretReference) {
    if (
        !/^[A-Za-z_][A-Za-z0-9_-]{0,159}$/.test(ref.issuerId) ||
        !/^[A-Za-z_][A-Za-z0-9_-]{0,159}$/.test(ref.secretRef) ||
        ![ref.workspaceId, ref.versionId].every((v) => /^[0-9a-f-]{36}$/i.test(v))
    )
        throw new Error("INVALID_SECRET_REFERENCE");
    return JSON.stringify([
        ref.issuerId,
        ref.workspaceId,
        ref.secretRef,
        ref.versionId,
    ]);
}
/**
 * 公开类 SecretStore 在私有配置中持久化本机密钥：原生保险库接入留给安装形态：开发期使用受限文件缝（SecretStore/INVALID_SECRET_VALUE）。
 */
export class SecretStore {
    constructor(readonly directory: string) {}
    /**
     * 公开方法 set 校验 JsonValue 后按钉选引用写入本机密钥表：覆盖同引用旧值（set/INVALID_SECRET_VALUE）。
     */
    async set(ref: SecretReference, value: SecretValue) {
        if (validateSchema("JsonValue", value).length)
            throw new Error("INVALID_SECRET_VALUE");
        await updatePrivate<Record<string, JsonValue>>(
            this.directory,
            "local-secrets.json",
            (old) => ({ ...old, [key(ref)]: value }),
        );
    }
    /**
     * 公开方法 remove 删除指定钉选引用的本机密钥：不影响其他版本条目（remove/LOCAL_CREDENTIAL_MISSING）。
     */
    async remove(ref: SecretReference) {
        await updatePrivate<Record<string, JsonValue>>(
            this.directory,
            "local-secrets.json",
            (old) => {
                const next = old ?? {};
                delete next[key(ref)];
                return next;
            },
        );
    }
    /**
     * 公开方法 clear 清空本机密钥表：用于开发目录重置：不影响信任根或其他私有配置（clear/LOCAL_CREDENTIAL_MISSING）。
     */
    async clear() {
        await updatePrivate<Record<string, JsonValue>>(
            this.directory,
            "local-secrets.json",
            () => ({}),
        );
    }
    /**
     * 公开方法 resolve 按完整钉选引用读取密钥：缺失时抛出 LOCAL_CREDENTIAL_MISSING，绝不回落最新版本。
     */
    async resolve(ref: SecretReference): Promise<SecretValue> {
        const pin = key(ref);
        try {
            const data = await readPrivate<Record<string, JsonValue>>(
                this.directory,
                "local-secrets.json",
            );
            if (!Object.hasOwn(data, pin)) throw new Error();
            return data[pin]!;
        } catch {
            throw new Error("LOCAL_CREDENTIAL_MISSING");
        }
    }
}
/**
 * 公开类 SecretResolver 在 Attempt 钉选集合内授权密钥查找：超出 issuer/workspace/版本表即失败。
 */
export class SecretResolver {
    constructor(private store: SecretStore) {}
    /**
     * 公开方法 resolve 校验引用落在 Attempt 的 secretVersions 钉选表内，通过后才委托 SecretStore 取值，防止跨范围读密。
     */
    async resolve(
        ref: SecretReference,
        attempt: {
            issuerId: string;
            workspaceId: string;
            secretVersions: { secretRef: string; versionId: string }[];
        },
    ): Promise<SecretValue> {
        if (
            ref.issuerId !== attempt.issuerId ||
            ref.workspaceId !== attempt.workspaceId ||
            !attempt.secretVersions.some(
                (p) => p.secretRef === ref.secretRef && p.versionId === ref.versionId,
            )
        )
            throw new Error("CREDENTIAL_SCOPE_MISMATCH");
        return this.store.resolve(ref);
    }
}
