import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { projectConnectedSource } from "@veriq/compiler";
import { canonicalBytes, validateSchema } from "@veriq/contracts";
import { asset, id, snapshot } from "../../../packages/compiler/tests/helpers.ts";
import { signedLegacyDatasetReader } from "../src/offline/legacy-datasets.ts";

const versionId = id(3);
const document = {
    schemaVersion: "1.0",
    columns: { name: "string" },
    rows: Array.from({ length: 90 }, (_, i) => ({ key: String(i), values: { name: "x".repeat(500) } })),
};
const original = snapshot(undefined, [asset(3, "DATASET", document)]);
const projected = projectConnectedSource(original);
const first = { type: "dataset", selection: { selection: "DATASET", versionId } };

test("offline legacy reads return only signed bytes and bound compiler and case transfers", () => {
    const receiptSource = {
        ...original,
        validationTarget: { resourceId: id(101), versionId: id(1), revision: 7, kind: "CASE" as const },
    };
    const receive = signedLegacyDatasetReader(receiptSource, projected);
    for (let i = 0; i < 2; i++) {
        const start = receive(first);
        assert.equal(start.offset, 0);
        const part = Buffer.from(start.part, "base64");
        assert.equal(part.length, 32768);
        assert.throws(() => receive(first), /INVALID_DATASET_TRANSFER/);
        assert.throws(() => receive({ type: "dataset", id: start.id, offset: 1 }), /INVALID_DATASET_TRANSFER/);
        const end = receive({ type: "dataset", id: start.id, offset: part.length });
        const bytes = Buffer.concat([part, Buffer.from(end.part, "base64")]);
        assert.deepEqual(bytes, Buffer.from(canonicalBytes(document)));
        assert.equal(end.size, bytes.length);
        assert.equal(end.id, start.id);
    }
    assert.throws(() => receive(first), /DATASET_TRANSFER_LIMIT/);
});

test("offline legacy reads reject mismatched provenance and unsupported selections before returning bytes", () => {
    assert.throws(
        () => signedLegacyDatasetReader(original, { ...projected, originalSha256: "0".repeat(64) }),
        /DATASET_HASH_MISMATCH/,
    );
    const altered = structuredClone(projected);
    const descriptor = altered.assets.find((item) => item.kind === "DATASET");
    assert.ok(descriptor && descriptor.kind === "DATASET");
    descriptor.contentSha256 = "0".repeat(64);
    assert.throws(() => signedLegacyDatasetReader(original, altered)(first), /DATASET_HASH_MISMATCH/);
    const receive = signedLegacyDatasetReader(original, projected);
    assert.throws(() => receive({ type: "httpDataset", selection: first.selection }), /INVALID_DATASET_TRANSFER/);
    assert.throws(
        () => receive({ type: "dataset", selection: { selection: "VALIDATION_SOURCE" } }),
        /INVALID_DATASET_TRANSFER/,
    );
    assert.throws(
        () => receive({ type: "dataset", selection: { selection: "ROW", versionId, rowKey: "0" } }),
        /INVALID_DATASET_TRANSFER/,
    );
    assert.throws(
        () => receive({ type: "dataset", selection: { selection: "DATASET", versionId: id(99) } }),
        /BUNDLE_DATASET_MISSING/,
    );
    const fixture = new URL("../../../packages/contracts/fixtures/http-dataset.json", import.meta.url);
    const remoteDocument = JSON.parse(readFileSync(fixture, "utf8"));
    assert.deepEqual(validateSchema("DatasetV2", remoteDocument), []);
    const remote = snapshot(undefined, [asset(3, "DATASET", remoteDocument)]);
    assert.throws(
        () => signedLegacyDatasetReader(remote, projectConnectedSource(remote)),
        /OFFLINE_DATASET_VERSION_UNSUPPORTED/,
    );
});
