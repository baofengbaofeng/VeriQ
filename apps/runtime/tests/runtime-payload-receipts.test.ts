import { canonicalBytes } from "@veriq/contracts";
import assert from "node:assert/strict";
import test from "node:test";
import {
    verifyRuntimePayloadInputs as verify,
    RuntimePayloadError,
} from "../scripts/runtime-payload-inputs.ts";
import {
    fixture,
    model,
    bytes,
    hash,
    rebindSource,
    replaceEngineFile,
} from "./fixtures/runtime-payload.ts";
/** 每个 receipt 都在独立摘要更新后进入正式入口，跨记录拒绝不能只依赖配方 hash 不匹配；这些反例覆盖来源、构建工具、生产定义与引擎原库存的具体约束。 */
const failure = (e: unknown) => e instanceof RuntimePayloadError;
for (const kind of ["entries", "execution", "dependencies", "native", "engine"] as const)
    test(`receipt ${kind} source mismatch rejects`, async () =>
        fixture(async (f) => {
            f.receipts[kind].build.sourceBindingSha256 = "e".repeat(64);
            await assert.rejects(
                verify(await f.save(), f.expected, { inputRoot: f.root }),
                failure,
            );
        }));
test("native test-only defines fail production admission", async () =>
    fixture(async (f) => {
        f.receipts.native.outputs[0]!.defines.push("VERIQ_FAULT_INJECTION=1");
        await assert.rejects(verify(await f.save(), f.expected, { inputRoot: f.root }), failure);
    }));
test("engine raw inventory digest cannot substitute canonical selected entry digest", async () =>
    fixture(async (f) => {
        f.receipts.engine.entrySha256 = f.receipts.engine.inventory.sha256;
        await assert.rejects(verify(await f.save(), f.expected, { inputRoot: f.root }), failure);
    }));
test("node archive references and npm graph endpoints must close without claiming package verification", async () =>
    fixture(async (f) => {
        f.nodeReceipt.npmGraph.edges.push({
            from: "p1",
            alias: "missing",
            kind: "dependency",
            requested: "*",
            to: "p99",
            absence: null,
        });
        await assert.rejects(verify(await f.save(), f.expected, { inputRoot: f.root }), failure);
    }));

/** 冻结生产来源集不能由任意已绑定源码替换，显式产品宏也不能注入新的命名空间或编译模式；这些反例的所有 Ref 都能真实读到，只有严格生产集合比较才能阻断。 */
test("native exact production source and macro sets are mandatory", async () => {
    for (const change of [
        (f: Parameters<Parameters<typeof fixture>[0]>[0]) => {
            f.receipts.native.outputs[0]!.sourceFiles = [
                f.sourceBinding.files.find((x) => x.path.endsWith("producer.mjs"))!,
            ];
        },
        (f: Parameters<Parameters<typeof fixture>[0]>[0]) => {
            f.receipts.native.outputs[0]!.defines.push("CUSTOM_NAMESPACE=other");
        },
        (f: Parameters<Parameters<typeof fixture>[0]>[0]) => {
            f.receipts.native.outputs[1]!.defines.push("NAPI_VERSION=9");
        },
    ])
        await fixture(async (f) => {
            change(f);
            await assert.rejects(
                verify(await f.save(), f.expected, { inputRoot: f.root }),
                (e: unknown) =>
                    e instanceof RuntimePayloadError && e.code === "PAYLOAD_NATIVE_INPUT_INVALID",
            );
        });
});

/** 每种外部文档及其实际出现的嵌套 DTO 都经过缺字段与 unknown 变异，外层 Ref 摘要同时重算；来源文档还更新独立 expected 与各 Build 绑定，避免结构错误被早期摘要不一致掩盖。 */
test("all receipt kinds and nested DTOs reject missing and unknown fields", async () => {
    const seed = model();
    let exercised = 0;
    for (const [docPath, document] of seed.docs) {
        const locations: (string | number)[][] = [];
        const visit = (v: unknown, path: (string | number)[]) => {
            if (Array.isArray(v)) {
                if (v.length) visit(v[0], [...path, 0]);
            } else if (v && typeof v === "object") {
                locations.push(path);
                for (const [key, child] of Object.entries(v)) visit(child, [...path, key]);
            }
        };
        visit(document, []);
        for (const location of locations)
            for (const action of ["missing", "unknown"]) {
                await fixture(async (f) => {
                    const copy = structuredClone(f.docs.get(docPath));
                    f.docs.set(docPath, copy);
                    let target: unknown = copy;
                    for (const key of location)
                        target = (target as Record<string | number, unknown>)[key];
                    const value = target as Record<string, unknown>;
                    if (action === "missing") delete value[Object.keys(value)[0]!];
                    else value.unexpected = "secret";
                    let input = await f.save();
                    if (docPath === f.recipe.source.binding.path) {
                        f.expected.sourceBindingSha256 = f.recipe.source.binding.sha256;
                        for (const receipt of Object.values(f.receipts))
                            receipt.build.sourceBindingSha256 = f.recipe.source.binding.sha256;
                        input = await f.save();
                    }
                    if (docPath === f.recipe.chromeLayout.path)
                        f.expected.chromeLayoutSha256 = f.recipe.chromeLayout.sha256;
                    await assert.rejects(
                        verify(input, f.expected, { inputRoot: f.root }),
                        (e: unknown) =>
                            e instanceof RuntimePayloadError && e.code === "PAYLOAD_INPUT_INVALID",
                        `${docPath}:${location.join(".")}:${action}`,
                    );
                    exercised++;
                });
            }
    }
    assert.ok(exercised > 100);
});

/** 缺失引用和 kind 串换不能因其它字段相似而通过，来源或工具声明也必须保持封闭；这些输入重新绑定 recipe 原字节，检查真正由文档读取或跨记录合同阻断。 */
test("receipt kinds missing refs tools and archive layout bindings reject", async () => {
    for (const change of [
        (f: ReturnType<typeof model>) => {
            f.recipe.entries.buildReceipt = f.recipe.execution.buildReceipt;
        },
        (f: ReturnType<typeof model>) => {
            f.recipe.tools[0]!.evidence = {
                ...f.recipe.tools[0]!.evidence,
                path: "evidence/missing.txt",
            };
        },
        (f: ReturnType<typeof model>) => {
            f.chromeReceipt.layoutSha256 = "f".repeat(64);
        },
        (f: ReturnType<typeof model>) => {
            f.nodeReceipt.npmGraph.instances[0]!.lockSnapshot = "other-archive";
        },
        (f: ReturnType<typeof model>) => {
            f.receipts.execution.build.toolNames = ["node", "pnpm"];
        },
    ])
        await fixture(async (f) => {
            change(f);
            await assert.rejects(
                verify(await f.save(), f.expected, { inputRoot: f.root }),
                failure,
            );
        });
});

/** dependencies.json 必须与所选原 inventory entry 的依赖列表一致，而不是只满足文件摘要；测试同步更新全部物理字节、文件 Ref 和 entry 摘要，仅保留内容列表差异，要求引擎一致性层明确拒绝
 * 。 */
test("engine dependencies JSON must match original inventory dependencies", async () =>
    fixture(async (f) => {
        const update = (path: string, content: Buffer) => {
            f.put(`trees/engine/${path}`, content);
            const fact = f.inventories.engine.files.find((x) => x.path === path)!;
            fact.sizeBytes = content.length;
            fact.sha256 = hash(content);
            return { path, sizeBytes: fact.sizeBytes, sha256: fact.sha256 };
        };
        const changed = update("dependencies.json", bytes([]));
        Object.assign(
            f.receipts.engine.files.find((x) => x.path === "dependencies.json")!,
            changed,
        );
        const raw = bytes(f.engineInventory);
        f.receipts.engine.inventory = update(
            "inventory.json",
            raw,
        ) as typeof f.receipts.engine.inventory;
        f.receipts.engine.entrySha256 = hash(canonicalBytes(f.engineInventory.engines[0]));
        await assert.rejects(
            verify(await f.save(), f.expected, { inputRoot: f.root }),
            (e: unknown) =>
                e instanceof RuntimePayloadError && e.code === "PAYLOAD_ENGINE_INPUT_INVALID",
        );
    }));

/** source package.json 属于一 MiB 类别，不能因为来源副本通用 JSON 上限较宽就先读正文；外层来源摘要全部重新绑定，真实文件仍是两字节，要求类别声明先失败且不退化成长度或 hash 错误。 */
test("fix1 source package manifest declaration rejects before body read", async () =>
    fixture(async (f) => {
        const file = f.put("packages/oversize/package.json", "{}");
        file.sizeBytes = 1024 ** 2 + 1;
        f.sourceBinding.files.push(file);
        rebindSource(f);
        await assert.rejects(
            verify(await f.save(), f.expected, { inputRoot: f.root }),
            (e: unknown) => e instanceof RuntimePayloadError && e.code === "PAYLOAD_LIMIT",
        );
    }));

/** 旧引擎 package 与 lock 正文从未经过较小类别上限，这两个真实有界文件可在全部摘要正确时被接受；测试使用合法 JSON 空白填充并同步绑定库存，要求修复后明确拒绝而非仅靠声明不符碰巧失败。 */
for (const [path, limit] of [
    ["package.json", 1024 ** 2],
    ["package-lock.json", 4 * 1024 ** 2],
] as const)
    test(`fix1 rebound oversize engine ${path} is rejected`, async () =>
        fixture(async (f) => {
            replaceEngineFile(f, path, Buffer.from("{}" + " ".repeat(limit - 1)));
            await assert.rejects(
                verify(await f.save(), f.expected, { inputRoot: f.root }),
                (e: unknown) => e instanceof RuntimePayloadError && e.code === "PAYLOAD_LIMIT",
            );
        }));

/** 同一真实普通来源副本可被多个工具和构建证据复用，来源读取并不豁免后续 evidence 角色的独立准入；完整入口仍只返回一条精确 checkedEvidence，不能把计费记录误当成尚未读到的成功事实。 */
test("fix1 full verifier accepts small source-first evidence reuse once", async () =>
    fixture(async (f) => {
        const ref = f.recipe.tools[0]!.evidence;
        f.sourceBinding.files.push({ ...ref });
        rebindSource(f);
        const report = await verify(await f.save(), f.expected, { inputRoot: f.root });
        assert.equal(report.checkedEvidence.filter((file) => file.path === ref.path).length, 1);
        assert.deepEqual(
            report.checkedEvidence.find((file) => file.path === ref.path),
            ref,
        );
    }));

/** 较小 JSON 类别只适用于已知源码与树成员，普通二进制来源和归档角色仍保留两 GiB 上限；这里使用小文件的大声明观察长度不符，若被误套 JSON 上限就会错误提前报告 LIMIT。 */
test("fix1 binary source and archive roles retain their larger ceiling", async () => {
    await fixture(async (f) => {
        const file = f.put("packages/source.bin", "small binary source");
        file.sizeBytes = 4 * 1024 ** 2 + 1;
        f.sourceBinding.files.push(file);
        rebindSource(f);
        await assert.rejects(
            verify(await f.save(), f.expected, { inputRoot: f.root }),
            (e: unknown) => e instanceof RuntimePayloadError && e.code === "PAYLOAD_TREE_MISMATCH",
        );
    });
    await fixture(async (f) => {
        f.recipe.source.archive = f.put("archives/opaque-source.json", "small opaque archive");
        f.recipe.source.archive.sizeBytes = 4 * 1024 ** 2 + 1;
        await assert.rejects(
            verify(await f.save(), f.expected, { inputRoot: f.root }),
            (e: unknown) => e instanceof RuntimePayloadError && e.code === "PAYLOAD_TREE_MISMATCH",
        );
    });
});
