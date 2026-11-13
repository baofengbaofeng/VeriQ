import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { expect, test } from "vitest";
import platform from "../schemas/platform-v1.schema.json" with { type: "json" };
import { parseContract, serializeContract, validateSchema } from "../src/index.js";

const api = JSON.parse(readFileSync(new URL("../openapi/platform.yaml", import.meta.url), "utf8"));
const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats.default(ajv);
ajv.addSchema(platform);
const apiId = "https://veriq.dev/openapi/platform.yaml";
// OpenAPI components are containers, not JSON Schema keywords. Preserve schemas
// while rebasing only local component references into a JSON Schema $defs root.
const definitions = JSON.parse(
    JSON.stringify(api.components.schemas, (key, value: unknown) =>
        key === "$ref" && typeof value === "string"
            ? value.replace(/^#\/components\/schemas\//, "#/$defs/")
            : value,
    ),
);
ajv.addSchema({ $id: apiId, $defs: definitions });
const validate = (name: string, value: unknown) => ajv.getSchema(`${apiId}#/$defs/${name}`)!(value);
const fixtures = JSON.parse(
    readFileSync(new URL("../fixtures/compatibility.json", import.meta.url), "utf8"),
);

test("every API component compiles with strict JSON Schema validation", () => {
    for (const name of Object.keys(definitions))
        expect(ajv.getSchema(`${apiId}#/$defs/${name}`)).toBeTypeOf("function");
});

test("draft updates require revision and typed resource documents", () => {
    const content = fixtures.find((x: { name: string }) => x.name === "asset-CASE").value;
    expect(validate("DraftWrite", { revision: 1, content })).toBe(true);
    expect(validate("DraftWrite", { content })).toBe(false);
    expect(validate("DraftWrite", { revision: 0, content })).toBe(false);
    expect(
        validate("DraftWrite", { revision: 1, content: { kind: "CASE", document: { steps: [] } } }),
    ).toBe(false);
});

test("success and error envelopes are strict and carry request correlation", () => {
    const claim = fixtures.find((x: { name: string }) => x.name === "claim-dto").value;
    expect(validate("ClaimDTOEnvelope", { requestId: "request-1", data: claim })).toBe(true);
    expect(validate("ClaimDTOEnvelope", { data: claim })).toBe(false);
    expect(validate("ClaimDTOEnvelope", { requestId: "request-1", data: claim, extra: true })).toBe(
        false,
    );
    expect(
        validate("ErrorEnvelope", {
            requestId: "request-1",
            code: "FORBIDDEN",
            message: "Not authorized",
            details: {},
        }),
    ).toBe(true);
    expect(
        validate("ErrorEnvelope", {
            requestId: "request-1",
            code: 403,
            message: "Not authorized",
            details: {},
        }),
    ).toBe(false);
});

test("member roles and Runtime trust updates use explicit allowed values", () => {
    expect(validate("MemberWrite", { role: "EXECUTOR", status: "ACTIVE" })).toBe(true);
    expect(validate("MemberWrite", { role: "SUPERUSER", status: "ACTIVE" })).toBe(false);
    expect(
        validate("RuntimeTrustWrite", { trustStatus: "MANAGED", allowCredentialDelivery: false }),
    ).toBe(true);
    expect(
        validate("RuntimeTrustWrite", {
            trustStatus: "MANAGED_CLOUD",
            allowCredentialDelivery: true,
        }),
    ).toBe(false);
});

test("maintenance batches report continuation explicitly", () => {
    const value = {
        id: "11111111-1111-4111-8111-111111111111",
        status: "FINISHED",
        processedCount: 3,
        hasMore: false,
    };
    expect(validate("MaintenanceDTO", value)).toBe(true);
    const { hasMore: _, ...incomplete } = value;
    expect(validate("MaintenanceDTO", incomplete)).toBe(false);
});

test("a completed validation job exposes a bound receipt usable by publish", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const resourceRoute = "/api/v1/workspaces/{workspaceId}/resources/{resourceId}";
    const validation = api.paths[`${resourceRoute}/validate`].post;
    const jobResponseSchema = validation.responses["202"].content["application/json"].schema.$ref
        .split("/")
        .at(-1);
    const queued = {
        data: { id, workspaceId: id, kind: "VALIDATE", state: "QUEUED" },
        requestId: "request-1",
    };
    expect(validate(jobResponseSchema, queued)).toBe(true);
    const completed = { ...queued, data: { ...queued.data, state: "FINISHED" } };
    const poll = api.paths["/api/v1/workspaces/{workspaceId}/jobs/{jobId}"].get;
    expect(
        validate(
            poll.responses["200"].content["application/json"].schema.$ref.split("/").at(-1),
            completed,
        ),
    ).toBe(true);
    const receipt = {
        id,
        runtimeId: id,
        attemptId: id,
        compilerTrust: "MANAGED",
        workspaceId: id,
        jobId: id,
        resourceId: id,
        revision: 3,
        sourceHash: "a".repeat(64),
        engineVersion: "1.0.0",
        compiledBundleSha256: "b".repeat(64),
        validatedAt: "2026-11-10T10:00:00Z",
    };
    expect(receipt.jobId).toBe(completed.data.id);
    expect(receipt.workspaceId).toBe(completed.data.workspaceId);
    expect(validate("ValidationReceiptDTO", receipt)).toBe(true);
    const response = { data: receipt, requestId: "request-1" };
    const operation =
        api.paths["/api/v1/workspaces/{workspaceId}/jobs/{jobId}/validation-receipt"]?.get;
    expect(operation).toBeDefined();
    const responseSchema = operation.responses["200"].content["application/json"].schema.$ref;
    expect(responseSchema).toBe("#/components/schemas/ValidationReceiptDTOEnvelope");
    expect(validate(responseSchema.split("/").at(-1), response)).toBe(true);
    const publishSchema = api.paths[`${resourceRoute}/publish`].post.requestBody.content[
        "application/json"
    ].schema.$ref
        .split("/")
        .at(-1);
    expect(
        validate(publishSchema, {
            revision: response.data.revision,
            validationReceiptId: response.data.id,
        }),
    ).toBe(true);
    const { sourceHash: _, ...unbound } = receipt;
    expect(validate("ValidationReceiptDTO", unbound)).toBe(false);
});

test("inert API errors preserve rejected expressions verbatim", () => {
    expect(
        validate("ErrorEnvelope", {
            code: "INVALID_DSL",
            message: "Invalid {{evil()}}",
            details: { actual: "{{customer.name}}" },
            requestId: "request-1",
        }),
    ).toBe(true);
});

test("claim, manifest, frozen subject, compiled bundle and files have exact-byte device addresses", () => {
    const route = "/internal/v1/workspaces/{workspaceId}/attempts/{attemptId}/content/{sha256}";
    const operation = api.paths[route]?.get;
    expect(operation).toBeDefined();
    const sample = (name: string) =>
        structuredClone(fixtures.find((x: { name: string }) => x.name === name).value);
    const digest = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
    // This map represents immutable bytes, not an HTTP/storage implementation.
    const content = new Map<string, string>();
    const store = (schema: string, value: unknown) => {
        const bytes = serializeContract(schema, value);
        const hash = digest(bytes);
        content.set(hash, bytes);
        return hash;
    };
    const fileBytes = "export const frozen = true;\n";
    const fileHash = digest(fileBytes);
    content.set(fileHash, fileBytes);
    const compiled = sample("compiled-bundle");
    compiled.files = [
        { path: "case.ts", sha256: fileHash, sizeBytes: Buffer.byteLength(fileBytes) },
    ];
    compiled.entrypoints = [
        { caseVersionId: "11111111-1111-4111-8111-111111111111", path: "case.ts" },
    ];
    const compiledHash = store("CompiledAssetBundle", compiled);
    for (const kind of ["TEST", "VALIDATE", "CLEANUP"]) {
        const subjectSchema = kind === "VALIDATE" ? "AssetSnapshotV1" : "ExecutionSnapshotV1";
        const subject = sample(kind === "VALIDATE" ? "asset-snapshot" : "execution-snapshot");
        const subjectHash = store(subjectSchema, subject);
        const manifest = sample(`job-${kind}`);
        manifest.snapshotSha256 = subjectHash;
        if (kind === "TEST")
            Object.assign(manifest, {
                executionSnapshotSha256: subjectHash,
                compiledBundleSha256: compiledHash,
            });
        const manifestHash = store("JobManifestV1", manifest);
        const claim = sample("claim-dto");
        Object.assign(claim, { jobKind: kind, snapshotSha256: manifestHash });
        const address = (hash: string) =>
            route
                .replace("{workspaceId}", manifest.workspaceId)
                .replace("{attemptId}", claim.attemptId)
                .replace("{sha256}", hash);
        claim.snapshotUrl = "https://control.example" + address(manifestHash);
        expect(validateSchema("ClaimDTO", claim)).toEqual([]);
        const getBytes = (hash: string) => {
            const url = new URL(address(hash), "https://control.example");
            expect(url.search).toBe("");
            const values: Record<string, unknown> = {
                workspaceId: manifest.workspaceId,
                attemptId: claim.attemptId,
                sha256: hash,
                "X-VeriQ-Lease-Token": claim.leaseToken,
                "X-VeriQ-Fencing-Token": claim.fencingToken,
            };
            for (const parameter of operation.parameters) {
                const schema = JSON.parse(
                    JSON.stringify(parameter.schema, (key, value: unknown) =>
                        key === "$ref" && typeof value === "string"
                            ? value.replace(/^#\/components\/schemas\//, `${apiId}#/$defs/`)
                            : value,
                    ),
                );
                expect(ajv.compile(schema)(values[parameter.name])).toBe(true);
            }
            const bytes = content.get(hash)!;
            expect(digest(bytes)).toBe(hash);
            return bytes;
        };
        const downloaded = parseContract(
            "JobManifestV1",
            getBytes(claim.snapshotSha256),
        ) as typeof manifest;
        expect(parseContract(subjectSchema, getBytes(downloaded.snapshotSha256))).toEqual(subject);
        if (kind === "TEST") {
            const bundle = parseContract(
                "CompiledAssetBundle",
                getBytes(downloaded.compiledBundleSha256),
            ) as typeof compiled;
            expect(getBytes(bundle.files[0].sha256)).toBe(fileBytes);
            expect(Buffer.byteLength(fileBytes)).toBe(bundle.files[0].sizeBytes);
        }
    }
});

/** 执行令牌和维护令牌共享签发入口但不能共享操作范围，严格校验器同时接受完整四项维护权限并拒绝重复、未知和跨用途混合，避免生成客户端只表达部分维护能力或错误扩大自动化授权。 */
test("execution tokens have independent plan scopes and maintenance supports all four operations", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const operations = [
        "expired-leases/reap",
        "fixture-cleanups/reconcile",
        "capacity/reconcile",
        "artifacts/expire",
    ];
    expect(validate("ServiceTokenIssue", { purpose: "MAINTENANCE", operations })).toBe(true);
    expect(
        validate("ServiceTokenIssue", {
            purpose: "MAINTENANCE",
            operations: [operations[0], operations[0]],
        }),
    ).toBe(false);
    expect(validate("ServiceTokenIssue", { purpose: "MAINTENANCE", operations: ["unknown"] })).toBe(
        false,
    );
    expect(validate("ServiceTokenIssue", { purpose: "MAINTENANCE", operations: ["trigger"] })).toBe(
        false,
    );
    expect(
        validate("ServiceTokenIssue", {
            purpose: "EXECUTION",
            operations: ["trigger", "read"],
            planIds: [id],
        }),
    ).toBe(true);
    expect(
        validate("ServiceTokenIssue", {
            purpose: "EXECUTION",
            operations: ["trigger"],
            planIds: [],
        }),
    ).toBe(false);
    expect(validate("ServiceTokenIssue", { purpose: "EXECUTION", operations, planIds: [id] })).toBe(
        false,
    );
    expect(validate("ServiceTokenIssue", { purpose: "RUNTIME_ENROLLMENT", planIds: [id] })).toBe(
        false,
    );
});
