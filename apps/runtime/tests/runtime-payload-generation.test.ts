import assert from "node:assert/strict";
import test from "node:test";
import { verifyRuntimePayloadInputs } from "../scripts/runtime-payload-inputs.ts";
import { bindGeneratorSources } from "../scripts/runtime-payload-generation.ts";
import { fixture } from "./fixtures/runtime-payload.ts";
import { stageModel } from "./fixtures/runtime-payload-stage.ts";

test("fixed twenty actual generator sources match original input copies", async () => {
    await fixture(
        async (f) => {
            const report = await verifyRuntimePayloadInputs(await f.save(), f.expected, {
                inputRoot: f.root,
            });
            const binding = await bindGeneratorSources(report, f.root);
            assert.equal(binding.files.length, 20);
            await binding.finish();
        },
        await stageModel(),
    );
});

// 自报输入副本与全部构建绑定同步改成伪造源码时，普通输入核验仍可通过而实际生成器绑定必须拒绝；此反例保留真实宿主文件不写回仓库，证明来源核验不能只相信配方中相互一致的摘要声明。
test("forged source copies and synchronized bindings cannot impersonate actual generator code", async () => {
    const value = await stageModel();
    const source = value.sourceBinding.files.find((file) =>
        file.path.endsWith("runtime-payload-bins.ts"),
    )!;
    Object.assign(source, value.put(source.path, Buffer.from("export const forged = true;\n")));
    await fixture(async (f) => {
        const report = await verifyRuntimePayloadInputs(await f.save(), f.expected, {
            inputRoot: f.root,
        });
        await assert.rejects(bindGeneratorSources(report, f.root), {
            code: "PAYLOAD_SOURCE_CHANGED",
        });
    }, value);
});

// 导出的来源描述不能泄露可改写的 URL 对象从而改变内部宿主读取位置，调用者修改可见描述后仍必须绑定固定实际源码；反例只改内存中的 URL 并在 finally 恢复，不触碰真实仓库文件或读取任意调用者路径。
test("caller cannot redirect fixed host sources through exported URL objects", async () => {
    const { GENERATOR_SOURCES } = await import("../scripts/runtime-payload-generation.ts");
    const descriptor: unknown = GENERATOR_SOURCES[0]!.url;
    const original = descriptor instanceof URL ? descriptor.pathname : null;
    const value = await stageModel();
    try {
        if (descriptor instanceof URL) descriptor.pathname = "/unrelated-generator-source";
        await fixture(async (f) => {
            const report = await verifyRuntimePayloadInputs(await f.save(), f.expected, {
                inputRoot: f.root,
            });
            const binding = await bindGeneratorSources(report, f.root);
            await binding.finish();
        }, value);
    } finally {
        if (descriptor instanceof URL && original) descriptor.pathname = original;
    }
});

// 完成前的实际宿主重读通过受控 FileHandle 读取结果故障来模拟源码变化，真实仓库字节始终不写入；初次绑定必须成功而 finish 拒绝第二次不同内容，防止只做生成开始检查却漏掉结束复验的实现获得通过。
test("generator finish rejects changed host bytes without writing real repository", async (t) => {
    const { InputReader } = await import("../scripts/runtime-payload-tree.ts");
    const input = InputReader.prototype.input;
    let reads = 0;
    t.mock.method(
        InputReader.prototype,
        "input",
        async function (this: InstanceType<typeof InputReader>, path: string) {
            const content = await input.call(this, path);
            if (path === "runtime-payload-bins.ts" && ++reads === 2)
                return Buffer.concat([content, Buffer.from("\n")]);
            return content;
        },
    );
    try {
        await fixture(
            async (f) => {
                const report = await verifyRuntimePayloadInputs(await f.save(), f.expected, {
                    inputRoot: f.root,
                });
                const binding = await bindGeneratorSources(report, f.root);
                await assert.rejects(binding.finish(), { code: "PAYLOAD_SOURCE_CHANGED" });
                assert.equal(reads, 2);
            },
            await stageModel(),
        );
    } finally {
        t.mock.restoreAll();
    }
});
