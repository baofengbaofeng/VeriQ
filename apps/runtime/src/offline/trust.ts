import { createHash, createPublicKey } from "node:crypto";
import {
  controlOrigin,
  RuntimeClient,
  type DeviceConfig,
} from "../enrollment.ts";
import { readPrivate, updatePrivate } from "./config.ts";
export type IssuerKey = {
  keyId: string;
  algorithm: "Ed25519";
  publicKey: string;
  fingerprint: string;
  revoked: boolean;
};
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
/** Public roots deliberately survive device logout. Explicit profile deletion is separate. */
export class TrustStore {
  constructor(readonly directory: string) {}
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
  async bind(
    value: IssuerTrust,
    origin: string,
    fingerprint: string,
  ): Promise<void> {
    const issuer = validateIssuer(value),
      server = controlOrigin(origin);
    // Only this key is authenticated. Labels are local lookup aliases; unsigned
    // revisions, revocations and sibling keys have no authority.
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
      // Pre-fix caches cannot authenticate signers. Preserve only conservative
      // revoked fingerprints so explicit rebind cannot resurrect a known key.
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
