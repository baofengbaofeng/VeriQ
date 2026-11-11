import type { BrowserContext, Page } from "@playwright/test";
import type { JsonValue } from "@veriq/contracts";
import { mkdir, chmod } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
export interface RestrictedEvidence {
  kind: "TRACE" | "SCREENSHOT" | "DOWNLOAD";
  sensitivity: "CREDENTIAL_RESTRICTED";
  path: string;
}
/** Trusted engine/local policy only. T12 must enforce current server authorization. */
export class EvidencePolicy {
  private readonly values = new Set<string>();
  protect(value: JsonValue): void {
    if (typeof value === "string" && value) {
      this.values.add(value);
      this.values.add(encodeURIComponent(value));
      this.values.add(Buffer.from(value).toString("base64"));
    } else if (Array.isArray(value)) value.forEach((v) => this.protect(v));
    else if (value && typeof value === "object")
      Object.values(value).forEach((v) => this.protect(v));
  }
  readonly redact = (value: JsonValue): JsonValue => {
    if (typeof value === "string") {
      let output = value;
      for (const secret of [...this.values].sort((a, b) => b.length - a.length))
        output = output.replaceAll(secret, "[REDACTED]");
      return output;
    }
    if (Array.isArray(value)) return value.map(this.redact);
    if (value && typeof value === "object") {
      // Dynamic JSON keys are data. Withhold the whole object to avoid collisions.
      if (
        Object.keys(value).some((key) =>
          [...this.values].some((secret) => key.includes(secret)),
        )
      )
        return "[REDACTED]";
      const restricted =
        value.sensitivity === "CREDENTIAL_RESTRICTED" ||
        value.kind === "download";
      return Object.fromEntries(
        Object.entries(value)
          .filter(
            ([key]) =>
              !restricted ||
              !["path", "bytes", "body", "buffer", "url"].includes(key),
          )
          .map(([key, item]) => [
            key,
            /^(authorization|proxy-authorization|cookie|set-cookie|cleanupToken|x-veriq-lease-token|x-veriq-fencing-token)$/iu.test(
              key,
            )
              ? "[REDACTED]"
              : this.redact(item),
          ]),
      );
    }
    return value;
  };
  /** Engine-owned record trees have protocol IDs/enums; their dynamic values do not. */
  readonly redactProtocol = (value: JsonValue): JsonValue => {
    if (Array.isArray(value)) return value.map(this.redactProtocol);
    if (!value || typeof value !== "object") return this.redact(value);
    const identifiers = new Set([
      "type",
      "schemaVersion",
      "attemptId",
      "sequence",
      "timestamp",
      "stepId",
      "assertionId",
      "observerId",
      "requestId",
      "id",
      "status",
      "severity",
      "outcome",
      "businessOutcome",
      "cleanupStatus",
      "retrySafety",
      "errorCode",
      "blockedByStepId",
      "blockedByAssertionId",
      "windowMode",
      "kind",
      "sensitivity",
      "method",
      "dialogType",
      "handling",
      "pageKey",
    ]);
    const dynamic = new Set([
      "expected",
      "value",
      "data",
      "vars",
      "variables",
      "headers",
    ]);
    const restricted =
      value.sensitivity === "CREDENTIAL_RESTRICTED" ||
      value.kind === "download";
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key]) =>
            !restricted ||
            !["path", "bytes", "body", "buffer", "url"].includes(key),
        )
        .map(([key, item]) => [
          key,
          identifiers.has(key)
            ? item
            : dynamic.has(key)
              ? this.redact(item)
              : this.redactProtocol(item),
        ]),
    );
  };
  access(
    evidence: RestrictedEvidence,
    capability: { credentialEvidence: boolean },
  ): RestrictedEvidence {
    if (!capability.credentialEvidence)
      throw new Error("CREDENTIAL_EVIDENCE_FORBIDDEN");
    return evidence;
  }
  private async path(directory: string, extension: string): Promise<string> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    return join(directory, `${randomUUID()}.${extension}`);
  }
  async screenshot(page: Page, directory: string): Promise<RestrictedEvidence> {
    const path = await this.path(directory, "png");
    await page.screenshot({ path });
    await chmod(path, 0o600);
    return { kind: "SCREENSHOT", sensitivity: "CREDENTIAL_RESTRICTED", path };
  }
  async stopTrace(
    context: BrowserContext,
    directory: string,
  ): Promise<RestrictedEvidence> {
    const path = await this.path(directory, "zip");
    await context.tracing.stop({ path });
    await chmod(path, 0o600);
    return { kind: "TRACE", sensitivity: "CREDENTIAL_RESTRICTED", path };
  }
}
