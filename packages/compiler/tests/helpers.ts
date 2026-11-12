import { createHash } from "node:crypto";
import {
    assetSourceBytes,
    canonicalBytes,
    type AssetSnapshotV1,
    type AssetVersionV1,
    type CaseDslV1,
    type StepV1,
} from "@veriq/contracts";
export const id = (n: number) =>
    `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const hash = (v: Uint8Array) =>
    createHash("sha256").update(v).digest("hex");
export function asset(
    n: number,
    kind: AssetVersionV1["kind"],
    document: unknown,
): AssetVersionV1 {
    return {
        resourceId: id(n + 100),
        versionId: id(n),
        kind,
        document,
        sha256: hash(canonicalBytes({ kind, document })),
    } as AssetVersionV1;
}
export const catalog = () =>
    asset(2, "ELEMENT_CATALOG", {
        schemaVersion: "1.0",
        elements: [{ key: "name", locator: { by: "testId", value: "name" } }],
    });
export function snapshot(
    steps: StepV1[] = [{ id: "open", action: "goto", path: "/" }],
    extra: AssetVersionV1[] = [],
    patch: Partial<CaseDslV1> = {},
): AssetSnapshotV1 {
    const result = {
        schemaVersion: "1.0",
        workspaceId: id(99),
        engineVersion: "0.1.0",
        sourceHash: "0".repeat(64),
        entryCaseVersionIds: [id(1)],
        assets: [
            asset(1, "CASE", {
                schemaVersion: "1.0",
                caseKey: "read",
                title: "Read",
                kind: "READ",
                roleKey: "reader",
                catalogVersionId: id(2),
                steps,
                ...patch,
            }),
            catalog(),
            ...extra,
        ],
    } as AssetSnapshotV1;
    return rehash(result);
}
export function rehash(s: AssetSnapshotV1): AssetSnapshotV1 {
    for (const a of s.assets)
        a.sha256 = hash(canonicalBytes({ kind: a.kind, document: a.document }));
    s.sourceHash = hash(assetSourceBytes(s));
    return s;
}
