import type { JsonValue } from "@veriq/contracts";
import { validateSchema } from "@veriq/contracts";
import { readPrivate, updatePrivate } from "../offline/config.ts";
export type SecretReference = {
  issuerId: string;
  workspaceId: string;
  secretRef: string;
  versionId: string;
};
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
/** Restricted config implementation; native vault integration belongs to installation. */
export class SecretStore {
  constructor(readonly directory: string) {}
  async set(ref: SecretReference, value: SecretValue) {
    if (validateSchema("JsonValue", value).length)
      throw new Error("INVALID_SECRET_VALUE");
    await updatePrivate<Record<string, JsonValue>>(
      this.directory,
      "local-secrets.json",
      (old) => ({ ...old, [key(ref)]: value }),
    );
  }
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
  async clear() {
    await updatePrivate<Record<string, JsonValue>>(
      this.directory,
      "local-secrets.json",
      () => ({}),
    );
  }
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
/** Authorize every lookup against the immutable attempt's exact pins; no latest fallback. */
export class SecretResolver {
  constructor(private store: SecretStore) {}
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
