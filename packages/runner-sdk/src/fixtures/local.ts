import type { JsonValue } from "@veriq/contracts";
import type { CredentialProvider } from "../register-case.js";
type Reference = { workspaceId: string; secretRef: string; versionId: string };
/** Personal/offline default. T20 loads these values from OS vault or restricted local config. */
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
  async resolve(reference: Reference, signal: AbortSignal): Promise<JsonValue> {
    if (signal.aborted) throw new Error("CANCELLED");
    const value = this.records.get(this.key(reference));
    if (value === undefined) throw new Error("LOCAL_CREDENTIAL_REQUIRED");
    return structuredClone(value);
  }
}
