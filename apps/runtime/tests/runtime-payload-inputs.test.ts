import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import {
    parseRuntimePayloadInputs as parse,
    verifyRuntimePayloadInputs as verify,
    RuntimePayloadError,
    admitRuntimePayloadInputs,
} from "../scripts/runtime-payload-inputs.ts";
import { fixture, model, bytes, hash } from "./fixtures/runtime-payload.ts";

/** 错误断言必须经过正式异常类型和固定分类，不能让任意 TypeError 或模块载入失败替代预期行为；消息只含稳定分类，同时核对输入阶段不会虚构候选目录或清理成功。 */
export function rejects(code: string) {
    return (e: unknown) =>
        e instanceof RuntimePayloadError &&
        e.code === code &&
        e.phase === "INPUTS" &&
        e.cleanup === "NOT_NEEDED" &&
        e.candidateDirectory === null &&
        e.message === code;
}
for (const arch of ["x64", "arm64"] as const)
    test(`complete ${arch} directories return frozen inspection with all pending boundaries`, async () =>
        fixture(async (f) => {
            const recipeBytes = await f.save();
            const parsed = parse(recipeBytes, f.expected);
            assert.equal(parsed.target.arch, arch);
            assert.ok(Object.isFrozen(parsed.tools));
            const report = await verify(recipeBytes, f.expected, { inputRoot: f.root });
            assert.equal(report.kind, "MAC_RUNTIME_INPUT_INSPECTION");
            assert.equal(report.graphStatus, "STATIC_REFERENCES_VERIFIED");
            assert.deepEqual(report.pending, [
                "ARCHIVE_MEMBERS",
                "NPM_ARCHIVE_CONTENT_AND_GRAPH",
                "CHROME_PHYSICAL_LAYOUT",
                "TARGET_EXECUTION_AND_PROVENANCE",
                "FINAL_PAYLOAD_V2",
            ]);
            assert.equal(report.trees.execution.fileCount, 8);
            assert.ok(Object.isFrozen(report.trees.entries.inventory.files));
            assert.ok(Object.isFrozen(report.checkedEvidence));
            assert.equal(
                new Set(report.checkedEvidence.map((r) => r.path)).size,
                report.checkedEvidence.length,
            );
            assert.ok(report.checkedEvidence.some((r) => r.path === "archives/node.tar.gz"));
        }, model(arch)));

test("recipe schema rejects missing unknown wrong-type malformed hashes and declaration limits", () => {
    for (const change of [
        (r: Record<string, unknown>) => delete r.kind,
        (r: Record<string, unknown>) => (r.extra = true),
        (r: Record<string, unknown>) => (r.tools = null),
        (r: Record<string, unknown>) => ((r.source as Record<string, unknown>).commit = "secret"),
    ]) {
        const f = model();
        const r = JSON.parse(bytes(f.recipe).toString()) as Record<string, unknown>;
        change(r);
        const input = bytes(r);
        assert.throws(
            () => parse(input, { ...f.expected, recipeSha256: hash(input) }),
            rejects("PAYLOAD_INPUT_INVALID"),
        );
    }
    const f = model();
    f.recipe.node.file.sizeBytes = 2 ** 31 + 1;
    const b = f.seal();
    assert.throws(() => parse(b, f.expected), rejects("PAYLOAD_LIMIT"));
});

test("independent expected fields cannot be self-bootstrapped from recipe", () => {
    const f = model(),
        b = f.seal();
    for (const key of [
        "recipeSha256",
        "commit",
        "sourceBindingSha256",
        "pnpmLockSha256",
        "chromeLayoutSha256",
    ] as const) {
        const expected = structuredClone(f.expected);
        expected[key] = key === "commit" ? "b".repeat(40) : "e".repeat(64);
        assert.throws(() => parse(b, expected), rejects("PAYLOAD_EXPECTED_MISMATCH"));
    }
    for (const key of ["productVersion", "nodeVersion", "engineVersion", "arch"] as const) {
        const expected = structuredClone(f.expected);
        if (key === "arch") expected.target.arch = "arm64";
        else expected.target[key] = "24.0.1";
        assert.throws(() => parse(b, expected), rejects("PAYLOAD_EXPECTED_MISMATCH"));
    }
});

test("caller mutation after admission cannot change bytes expected or root policy", async () =>
    fixture(async (f) => {
        const b = await f.save(),
            expected = structuredClone(f.expected),
            options = { inputRoot: f.root };
        const task = verify(b, expected, options);
        b.fill(0);
        expected.target.arch = "arm64";
        expected.pnpmLockSha256 = "e".repeat(64);
        options.inputRoot = "/unrelated";
        assert.equal((await task).recipe.target.arch, "x64");
    }));

/** CLI 子进程只运行本机 Node 与正式 inspect 文件，不启动任何输入可执行内容；stdout 必须是单份完整报告，stderr 错误不能泄露参数、路径或配方中的秘密文本。 */
async function cli(args: string[]) {
    return await new Promise<{ code: number | null; out: string; err: string }>((done) => {
        const p = spawn(
            process.execPath,
            [
                "--import",
                "tsx",
                resolve(import.meta.dirname, "../scripts/inspect-macos-runtime-inputs.mjs"),
                ...args,
            ],
            { cwd: resolve(import.meta.dirname, ".."), stdio: ["ignore", "pipe", "pipe"] },
        );
        let out = "",
            err = "";
        p.stdout.on("data", (b) => (out += b));
        p.stderr.on("data", (b) => (err += b));
        p.on("close", (code) => done({ code, out, err }));
    });
}
test("actual inspect CLI emits complete JSON and rejects duplicate unknown missing flags", async () =>
    fixture(async (f) => {
        await writeFile(join(f.root, "inputs.json"), await f.save());
        await writeFile(join(f.root, "expected.json"), bytes(f.expected));
        const args = [
            "--inputs",
            join(f.root, "inputs.json"),
            "--expected",
            join(f.root, "expected.json"),
            "--input-root",
            f.root,
        ];
        const ok = await cli(args);
        assert.equal(ok.code, 0, ok.err);
        assert.equal(JSON.parse(ok.out).pending.length, 5);
        assert.equal(ok.err, "");
        for (const bad of [
            [...args, "--unknown", "secret"],
            [...args, "--inputs", "secret"],
            args.slice(0, -1),
        ]) {
            const result = await cli(bad);
            assert.notEqual(result.code, 0);
            assert.equal(result.out, "");
            assert.match(result.err, /PAYLOAD_INPUT_INVALID.*INPUTS.*NOT_NEEDED/);
            assert.ok(!result.err.includes("secret"));
        }
    }));

/** 精确 DTO 验收从完整样本逐个选择嵌套对象，分别删除必填字段、添加未知字段或替换为错误类型；每次重新绑定外层字节摘要，确保拒绝来自结构校验而不是无关的 recipe hash 门槛。 */
test("every populated recipe DTO rejects required unknown and wrong-type mutations", () => {
    const seed = model(),
        locations: (string | number)[][] = [];
    const visit = (value: unknown, path: (string | number)[]) => {
        if (Array.isArray(value)) {
            if (value.length) visit(value[0], [...path, 0]);
        } else if (value && typeof value === "object") {
            locations.push(path);
            for (const [key, child] of Object.entries(value)) visit(child, [...path, key]);
        }
    };
    visit(seed.recipe, []);
    for (const location of locations)
        for (const action of ["missing", "unknown", "type"]) {
            const value = JSON.parse(bytes(seed.recipe).toString()) as Record<string, unknown>;
            let selected: unknown = value;
            for (const key of location)
                selected = (selected as Record<string | number, unknown>)[key];
            const object = selected as Record<string, unknown>,
                key = Object.keys(object)[0]!;
            if (action === "missing") delete object[key];
            else if (action === "unknown") object.unexpected = "secret";
            else object[key] = false;
            const b = bytes(value);
            assert.throws(
                () => parse(b, { ...seed.expected, recipeSha256: hash(b) }),
                rejects("PAYLOAD_INPUT_INVALID"),
            );
        }
});

/** 有界 CLI 取消载体观察归档首个真实读取块再向同一 inspect 进程发送信号，不靠 sleep 猜测启动时间；可选 stalled close 只用于观察二次信号和期限后的 INCOMPLETE，所有载体退出后由宿主关闭
* 资源。 */
async function cancellation(
    root: string,
    signal: "SIGINT" | "SIGTERM",
    closeMode: "normal" | "second" | "timeout" = "normal",
) {
    const hold = closeMode !== "normal";
    const source = `process.argv.splice(1,0,'inspect');import fs from 'node:fs/promises';import{syncBuiltinESMExpor` +
        `ts}from'node:module';const alive=setInterval(()=>{},1000);const original=fs.open;fs.open=async(...args)=>{` +
        `const handle=await original(...args);if(String(args[0]).endsWith('/archives/node.tar.gz')){` +
        `${
            hold
                ? "handle.close=()=>{process.stderr.write('TEST_C" +
                    [
                        "LOSE_STARTED\\n');retur" +
                        "n new Promise(()=>{});};"] : ""}` +
                        `const originalStream=handle.createReadStream.bind(handle);handle.createReadStream=options=` +
                            `>{const stream=originalStream({...options,highWaterMark:1});stream.once('data',()=>{st` +
                            `ream._read=()=>{};process.stderr.write('TEST_READ_STARTED\\n');});return stream;};}ret` +
                            `urn handle;};syncBuiltinESMExports();try{await import(` +
                            `${
                                JSON.stringify(resolve(import.meta.dirname, "../scripts/inspect-macos-runtime-inputs" +
                                    ".mjs"))});}finally{clearInterval(alive);}`;
    return await new Promise<{ code: number | null; out: string; err: string }>((done, reject) => {
        const child = spawn(
            process.execPath,
            [
                "--import",
                "tsx",
                "--input-type=module",
                "-e",
                source,
                "--",
                "--inputs",
                join(root, "inputs.json"),
                "--expected",
                join(root, "expected.json"),
                "--input-root",
                root,
            ],
            { cwd: resolve(import.meta.dirname, ".."), stdio: ["ignore", "pipe", "pipe"] },
        );
        let out = "",
            err = "",
            sent = false,
            second = false;
        const timer = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error("CLI cancellation test timed out"));
        }, 8000);
        child.stdout.on("data", (b) => (out += b));
        child.stderr.on("data", (b) => {
            err += b;
            if (!sent && err.includes("TEST_READ_STARTED")) {
                sent = true;
                child.kill(signal);
            }
            if (closeMode === "second" && !second && err.includes("TEST_CLOSE_STARTED")) {
                second = true;
                child.kill(signal);
            }
        });
        child.on("error", (error) => {
            clearTimeout(timer);
            reject(error);
        });
        child.on("close", (code) => {
            clearTimeout(timer);
            done({ code, out, err });
        });
    });
}

/** 两种正常中断均发生于实际文件读取期间，退出码分别对应标准 SIGINT 和 SIGTERM，报告只能是取消错误；载体仅控制读取调度，不执行任何输入程序或对其它进程转发信号。 */
test("actual inspect CLI cancels mid-read with no success report", async () =>
    fixture(async (f) => {
        await writeFile(join(f.root, "inputs.json"), await f.save());
        await writeFile(join(f.root, "expected.json"), bytes(f.expected));
        for (const signal of ["SIGINT", "SIGTERM"] as const) {
            const result = await cancellation(f.root, signal);
            assert.equal(result.code, signal === "SIGINT" ? 130 : 143, result.err);
            assert.equal(result.out, "");
            assert.match(result.err, /PAYLOAD_CANCELLED phase=INPUTS cleanup=NOT_NEEDED/);
            assert.ok(!result.err.includes("INCOMPLETE"));
        }
    }));

/** 无法确认句柄关闭时二次信号与五秒期限必须诚实保留 INCOMPLETE，不能因为输入核验没有 scratch 就宣称清理完成；测试载体的关闭阻塞不会修改输入，子进程强制退出只影响它自己的句柄。 */
test("actual inspect CLI second signal and close deadline report incomplete", async () =>
    fixture(async (f) => {
        await writeFile(join(f.root, "inputs.json"), await f.save());
        await writeFile(join(f.root, "expected.json"), bytes(f.expected));
        for (const mode of ["second", "timeout"] as const) {
            const result = await cancellation(f.root, "SIGTERM", mode);
            assert.equal(result.code, 143, result.err);
            assert.equal(result.out, "");
            assert.match(result.err, /TEST_CLOSE_STARTED/);
            assert.match(result.err, /PAYLOAD_CANCELLED phase=INPUTS cleanup=INCOMPLETE/);
        }
    }));

/** 新增末尾上下文只复制阶段与目录标量，旧三个参数仍保持原来的输入阶段及空候选语义；共享准入必须为每次调用创建独立字节和政策，调用方后续改写不能影响真实消费者之间的绑定。 */
test("intake error context copies scalars while legacy constructor stays compatible", () => {
    const context = { phase: "INTAKE" as const, candidateDirectory: "/controlled/candidate" };
    const error = new RuntimePayloadError("PAYLOAD_IO", "EIO", "CONFIRMED", context);
    context.candidateDirectory = "/changed";
    assert.equal(error.phase, "INTAKE");
    assert.equal(error.candidateDirectory, "/controlled/candidate");
    assert.equal(new RuntimePayloadError("PAYLOAD_IO").phase, "INPUTS");
    assert.equal(new RuntimePayloadError("PAYLOAD_IO").candidateDirectory, null);
    assert.ok(Object.isFrozen(error));
});

/** 内部共享准入仍每次复制 caller 字节和独立 expected 政策，parse 与 verify 不依赖可被重用的旧准入对象；只读政策不冻结调用方，TypedArray 则保留私有所有权而不假称 Object.freez
* e 能保护其元素写入。 */
test("shared consumed admission returns independent bytes and policy each call", () => {
    const f = model(),
        input = f.seal(),
        expected = structuredClone(f.expected);
    const one = admitRuntimePayloadInputs(input, expected),
        two = admitRuntimePayloadInputs(input, expected);
    one.bytes.fill(0);
    input.fill(0);
    expected.target.arch = "arm64";
    assert.equal(hash(two.bytes), f.expected.recipeSha256);
    assert.equal(two.expected.target.arch, "x64");
    assert.ok(Object.isFrozen(two.expected.target));
    assert.notEqual(one.expected, two.expected);
});
