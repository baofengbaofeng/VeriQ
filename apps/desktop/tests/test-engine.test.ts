import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { canonicalBytes } from "@veriq/contracts";
import { testEngine } from "../../../tests/e2e/engine.ts";

/**
 * 候选参数在任何平台夹具启动前必须完整且可校验；自有临时库存只验证选择器的文件完整性与身份拒绝，不含可执行引擎、
 * 不修改生产批准目录，也不依赖历史 work 产物或 renderer 提供版本来绕过库存验证。
 */
test(
    "trusted engine selection verifies the selected in" + "ventory and rejects incomplete or wrong identities",
    async () => {
        const root = await realpath(await mkdtemp(join(tmpdir(), "veriq-test-engine-")));
        try {
            const directory = join(root, "selected");
            await mkdir(join(directory, "engine"), { recursive: true });
            const contents: Record<string, string> = {
                "package.json": '{"name":"isolated-selector-fixture"}',
                "package-lock.json": '{"lockfileVersion":3}',
                "dependencies.json": "[]",
                "engine/compiler.tgz": "selector-only fixture bytes",
            };
            const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
            const files = [];
            for (const [path, body] of Object.entries(contents)) {
                const bytes = Buffer.from(body);
                await writeFile(join(directory, path), bytes);
                files.push({ path, sizeBytes: bytes.length, sha256: digest(bytes) });
            }
            const entry = {
                engineVersion: "1.0.0",
                compilerVersion: "0.1.0",
                runnerSdkVersion: "0.1.0",
                files,
                dependencies: [],
            };
            await writeFile(
                join(directory, "inventory.json"),
                JSON.stringify({ schemaVersion: "1.0", engines: [entry] }),
            );
            const existing = { directory, version: "1.0.0", hash: digest(canonicalBytes(entry)) };
            await assert.rejects(testEngine(root, {}), {
                code: "ENOENT",
                path: join(root, "work/t18-engine-verified/inventory.json"),
            });
            await assert.rejects(
                testEngine(root, { VERIQ_TEST_ENGINE_DIRECTORY: existing.directory }),
                /INCOMPLETE_TEST_ENGINE/,
            );
            const override = {
                VERIQ_TEST_ENGINE_DIRECTORY: existing.directory,
                VERIQ_TEST_ENGINE_VERSION: existing.version,
                VERIQ_TEST_ENGINE_HASH: existing.hash,
            };
            assert.deepEqual(await testEngine(root, override), existing);
            await assert.rejects(
                testEngine(root, { ...override, VERIQ_TEST_ENGINE_HASH: "0".repeat(64) }),
                /TEST_ENGINE_HASH_MISMATCH/,
            );
            await assert.rejects(
                testEngine(root, { ...override, VERIQ_TEST_ENGINE_VERSION: "9.9.9" }),
                /ENGINE_NOT_APPROVED/,
            );
            await writeFile(join(directory, "engine/compiler.tgz"), "altered fixture bytes");
            await assert.rejects(testEngine(root, override), /RELEASE_HASH_MISMATCH/);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    },
);
