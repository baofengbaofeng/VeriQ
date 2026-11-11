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
  origins: Record<string, string>;
  issuers: Record<string, IssuerTrust>;
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
      if (!Object.hasOwn(cache.issuers, id)) throw new Error();
      const value = cache.issuers[id]!;
      return validateIssuer(value);
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
    // The caller explicitly compares an administrator-distributed fingerprint.
    if (!issuer.keys.some((k) => !k.revoked && k.fingerprint === fingerprint))
      throw new Error("FINGERPRINT_MISMATCH");
    await this.accept(issuer, server, true);
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
      const cache = old ?? { origins: {}, issuers: {} };
      if (
        cache.origins[origin] &&
        cache.origins[origin] !== value.issuerId &&
        !explicit
      )
        throw new Error("ISSUER_REBIND_REQUIRED");
      const prior = Object.hasOwn(cache.issuers, value.issuerId)
        ? cache.issuers[value.issuerId]
        : undefined;
      if (prior) {
        validateIssuer(prior);
        if (value.revision < prior.revision) throw new Error("ISSUER_ROLLBACK");
        for (const key of prior.keys) {
          const next = value.keys.find((k) => k.keyId === key.keyId);
          if (
            !next ||
            next.publicKey !== key.publicKey ||
            (key.revoked && !next.revoked)
          )
            throw new Error("ISSUER_REPLACEMENT");
        }
        if (
          value.revision === prior.revision &&
          JSON.stringify(value) !== JSON.stringify(prior)
        )
          throw new Error("ISSUER_REPLACEMENT");
      }
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
