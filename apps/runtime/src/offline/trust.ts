/**
 * 本文件管理离线包签发者信任根与指纹撤销：公钥绑定独立于设备登出：显式删档才会清除信任（trust/INVALID_ISSUER）。
 */

import { createHash, createPublicKey } from "node:crypto";
import {
    controlOrigin,
    RuntimeClient,
    type DeviceConfig,
} from "../enrollment.ts";
import { readPrivate, updatePrivate } from "./config.ts";
/**
 * 公开类型 IssuerKey 描述签发者公钥条目：含 keyId、指纹与撤销标记：供验签路径选用（IssuerKey/INVALID_ISSUER）。
 */
export type IssuerKey = {
    keyId: string;
    algorithm: "Ed25519";
    publicKey: string;
    fingerprint: string;
    revoked: boolean;
};
/**
 * 公开类型 IssuerTrust 描述某 issuer 的信任材料：含修订号与密钥列表：须经 validateIssuer 规范化。
 */
export type IssuerTrust = {
    issuerId: string;
    revision: number;
    keys: IssuerKey[];
};
type Cache = {
    version: 2;
    origins: Record<string, string>;
    issuers: Record<string, IssuerTrust>;
    authenticated: Record<string, IssuerTrust>;
    revokedFingerprints: string[];
};
const keyPattern = /^[A-Za-z_][A-Za-z0-9_-]{0,159}$/;
/**
 * 公开函数 publicKey 从 IssuerKey 构造可用于验签的公钥对象：拒绝无法识别的算法或损坏材料（publicKey/INVALID_ISSUER）。
 */
export function publicKey(key: IssuerKey) {
    const raw = Buffer.from(key.publicKey, "base64");
    if (
        raw.length !== 32 ||
        raw.toString("base64") !== key.publicKey ||
        createHash("sha256").update(raw).digest("hex") !== key.fingerprint
    )
        throw new Error("INVALID_ISSUER");
    return createPublicKey({
        key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]),
        format: "der",
        type: "spki",
    });
}
/**
 * 公开函数 validateIssuer 校验 IssuerTrust 结构并深拷贝：发现重复 keyId 或非法密钥立即失败。
 */
export function validateIssuer(value: IssuerTrust): IssuerTrust {
    if (
        !value ||
        !keyPattern.test(value.issuerId) ||
        !Number.isSafeInteger(value.revision) ||
        value.revision < 1 ||
        !Array.isArray(value.keys) ||
        !value.keys.length ||
        value.keys.length > 100
    )
        throw new Error("INVALID_ISSUER");
    const seen = new Set<string>();
    for (const k of value.keys) {
        if (
            !keyPattern.test(k.keyId) ||
            k.algorithm !== "Ed25519" ||
            typeof k.revoked !== "boolean" ||
            seen.has(k.keyId)
        )
            throw new Error("INVALID_ISSUER");
        publicKey(k);
        seen.add(k.keyId);
    }
    return structuredClone(value);
}
/**
 * 公开类 TrustStore 在私有目录持久化签发者信任：支持 bind/refresh：登出设备不会自动清空公钥根（TrustStore/ISSUER_NOT_TRUSTED）。
 */
export class TrustStore {
    constructor(readonly directory: string) {}
    /**
     * 公开方法 issuer 读取并校验已绑定的签发者材料：应用本地撤销指纹：缺失则抛出 ISSUER_NOT_TRUSTED。
     */
    async issuer(id: string): Promise<IssuerTrust> {
        try {
            const cache = await readPrivate<Cache>(this.directory, "trust.json");
            if (cache.version !== 2 || !Object.hasOwn(cache.issuers, id))
                throw new Error();
            const value = cache.issuers[id]!;
            const result = validateIssuer(value);
            for (const key of result.keys)
                if (cache.revokedFingerprints.includes(key.fingerprint))
                    key.revoked = true;
            return result;
        } catch {
            throw new Error("ISSUER_NOT_TRUSTED");
        }
    }
    /**
     * 公开方法 bind 仅在指纹匹配的未撤销密钥上建立信任：标签只作本地别名：未签名修订无权威（bind/FINGERPRINT_MISMATCH）。
     */
    async bind(
        value: IssuerTrust,
        origin: string,
        fingerprint: string,
    ): Promise<void> {
        const issuer = validateIssuer(value),
            server = controlOrigin(origin);
        // 仅该指纹密钥通过认证；标签只是本地别名，未签名修订/撤销/兄弟密钥无权威。
        const key = issuer.keys.find(
            (k) => !k.revoked && k.fingerprint === fingerprint,
        );
        if (!key) throw new Error("FINGERPRINT_MISMATCH");
        await this.accept(
            { issuerId: issuer.issuerId, revision: 1, keys: [key] },
            server,
            true,
        );
    }
    /**
     * 公开方法 refresh 经已注册设备令牌从 HTTPS 控制面刷新签发者材料：拒绝非 HTTPS Origin（refresh/AUTHENTICATED_HTTPS_REQUIRED）。
     */
    async refresh(config: DeviceConfig, signal?: AbortSignal): Promise<void> {
        const server = controlOrigin(config.server);
        if (!server.startsWith("https://"))
            throw new Error("AUTHENTICATED_HTTPS_REQUIRED");
        const issuer = validateIssuer(
            await new RuntimeClient(server).request<IssuerTrust>(
                "/internal/v1/issuer",
                "GET",
                undefined,
                config.deviceToken,
                signal,
            ),
        );
        await this.accept(issuer, server, false);
    }
    private async accept(value: IssuerTrust, origin: string, explicit: boolean) {
        await updatePrivate<Cache>(this.directory, "trust.json", (old) => {
            // 旧缓存不能认证签发者；只保守保留撤销指纹，避免显式重绑复活已知密钥。
            const cache: Cache =
                old?.version === 2
                    ? old
                    : {
                            version: 2,
                            origins: {},
                            issuers: {},
                            authenticated: {},
                            revokedFingerprints: Object.values(old?.issuers ?? {}).flatMap(
                                (issuer) =>
                                    validateIssuer(issuer)
                                        .keys.filter((k) => k.revoked)
                                        .map((k) => k.fingerprint),
                            ),
                        };
            if (
                cache.origins[origin] &&
                cache.origins[origin] !== value.issuerId &&
                !explicit
            )
                throw new Error("ISSUER_REBIND_REQUIRED");
            const prior = Object.hasOwn(cache.issuers, value.issuerId)
                ? cache.issuers[value.issuerId]
                : undefined;
            const authenticated = Object.hasOwn(cache.authenticated, value.issuerId)
                ? cache.authenticated[value.issuerId]
                : undefined;
            if (explicit) {
                const key = value.keys[0]!;
                if (cache.revokedFingerprints.includes(key.fingerprint))
                    throw new Error("ISSUER_KEY_REVOKED");
                const existing = prior?.keys.find((k) => k.keyId === key.keyId);
                if (existing && existing.publicKey !== key.publicKey)
                    throw new Error("ISSUER_REPLACEMENT");
                value = {
                    issuerId: value.issuerId,
                    revision: authenticated?.revision ?? 1,
                    keys: [
                        ...(prior?.keys.filter((k) => k.keyId !== key.keyId) ?? []),
                        key,
                    ],
                };
            } else {
                if (authenticated && value.revision < authenticated.revision)
                    throw new Error("ISSUER_ROLLBACK");
                if (
                    authenticated &&
                    value.revision === authenticated.revision &&
                    JSON.stringify(value) !== JSON.stringify(authenticated)
                )
                    throw new Error("ISSUER_REPLACEMENT");
                for (const key of prior?.keys ?? []) {
                    const next = value.keys.find((k) => k.keyId === key.keyId);
                    if (
                        !next ||
                        next.publicKey !== key.publicKey ||
                        (key.revoked && !next.revoked)
                    )
                        throw new Error("ISSUER_REPLACEMENT");
                }
                for (const key of value.keys) {
                    if (
                        !key.revoked &&
                        cache.revokedFingerprints.includes(key.fingerprint)
                    )
                        throw new Error("ISSUER_KEY_REVOKED");
                    if (
                        key.revoked &&
                        !cache.revokedFingerprints.includes(key.fingerprint)
                    )
                        cache.revokedFingerprints.push(key.fingerprint);
                }
                Object.defineProperty(cache.authenticated, value.issuerId, {
                    value: structuredClone(value),
                    enumerable: true,
                    writable: true,
                    configurable: true,
                });
            }
            if (value.keys.length > 100) throw new Error("INVALID_ISSUER");
            Object.defineProperty(cache.origins, origin, {
                value: value.issuerId,
                enumerable: true,
                writable: true,
                configurable: true,
            });
            Object.defineProperty(cache.issuers, value.issuerId, {
                value,
                enumerable: true,
                writable: true,
                configurable: true,
            });
            return cache;
        });
    }
}
