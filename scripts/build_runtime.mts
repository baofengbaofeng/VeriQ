#!/usr/bin/env node
/**
 * Runtime 构建命令把真实材料生产与独立 Expected 核验分成明确动作，所有子进程由现有有界管理器执行；命令不生成信任期望、不运行候选角色、不授予来源批准、签名安装或产品 ready。
 * mac-inputs 生产五树与原配方，mac-stage 只消费外部独立 Expected 后委托原 stage，v1-inputs 使用现有 Linux/Windows 发行合同。
 * package 消费已经完成的静态候选并输出归档和校验和，失败现场保留，所有标准日志采用英文稳定分类。
 */
import { open, lstat } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute } from "node:path";
import { produceMacRuntimeInputs, stageProducedMacRuntime, type MacRuntimeProductionJob } from "../apps/runtime/scripts/runtime-release.ts";
import { produceRuntimeV1, type RuntimeV1ProductionJob } from "../apps/runtime/scripts/runtime-release-v1.ts";
import { packageRuntimeCandidate } from "../apps/runtime/scripts/runtime-release-package.ts";
import { runBoundedAssetCli } from "../apps/runtime/scripts/runtime-assets-ci-process.mjs";
import type { ExpectedPayloadInputs } from "../apps/runtime/scripts/runtime-payload-inputs.ts";
import type { MacChromeLayout, MacRuntimeArch } from "../apps/runtime/src/distribution-manifest-v2.ts";

/**
 * 命令行只接受固定动作的精确参数集合和绝对宿主路径，每个参数仅能出现一次；没有环境变量后备、隐式下载、默认发行版本或从候选清单推导出的可信期望值。
 * 单独 package 需要独立 Mac policy 文档才能允许 Framework 链接，非 Mac 不提供此文档并坚持原有无链接合同。
 */
function argumentsFor(command: string | undefined, args: string[]): Map<string, string> {
    const definitions: Record<string, { required: string[]; optional?: string[] }> = {
        "mac-inputs": { required: ["--job"] },
        "v1-inputs": { required: ["--job"] },
        "mac-stage": { required: ["--recipe", "--expected", "--input-root", "--output-parent", "--candidate"] },
        "package": { required: ["--runtime-root", "--receipt", "--output-parent", "--candidate"], optional: ["--mac-policy"] },
    };
    const definition = command ? definitions[command] : undefined;
    if (!definition || args.length % 2) throw new Error("RUNTIME_BUILD_ARGUMENTS_INVALID");
    const allowed = [...definition.required, ...(definition.optional ?? [])], values = new Map<string, string>();
    for (let index = 0; index < args.length; index += 2) {
        const name = args[index]!, value = args[index + 1]!;
        if (!allowed.includes(name) || values.has(name) || !value || value.startsWith("--") ||
            (name !== "--candidate" && !isAbsolute(value))) throw new Error("RUNTIME_BUILD_ARGUMENTS_INVALID");
        values.set(name, value);
    }
    if (definition.required.some((name) => !values.has(name))) throw new Error("RUNTIME_BUILD_ARGUMENTS_INVALID");
    return values;
}

/**
 * 外层 JSON 在描述符上有限读取并比较开始结束身份，禁止链接、hardlink 和超过四 MiB 的输入；解析成功仅表示数据可读，生产器和 stage 仍执行自己的精确合同及来源核验。
 * 不回显原始解析异常、文件内容或任意路径，以免将用户配置材料带入构建日志。
 */
async function inputBytes(path: string): Promise<Buffer> {
    const before = await lstat(path, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > 4n * 1024n * 1024n)
        throw new Error("RUNTIME_BUILD_INPUT_INVALID");
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        const opened = await handle.stat({ bigint: true });
        if (opened.dev !== before.dev || opened.ino !== before.ino) throw new Error("RUNTIME_BUILD_INPUT_CHANGED");
        const bytes = await handle.readFile();
        const after = await handle.stat({ bigint: true });
        if (bytes.length !== Number(before.size) || after.size !== before.size ||
            after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs)
            throw new Error("RUNTIME_BUILD_INPUT_CHANGED");
        return bytes;
    } finally { await handle.close(); }
}

/**
 * 顶层只调度已经明确授权的源码动作，异常不伪造 cleanup 或 committed 状态，保留底层首错的稳定英文分类；中断不递归删除未知构建现场，实际后代结算边界仍由各 producer 和后续验证任务确认。
 * 此脚本本身不调用 CI、测试、代码审查或安装器，真实构建仅在操作者后续显式执行相应动作时发生。
 */
try {
    const command = process.argv[2];
    const flags = argumentsFor(command, process.argv.slice(3));
    const get = (name: string) => flags.get(name)!;
    let result: unknown;
    if (command === "mac-inputs") {
        const job = JSON.parse((await inputBytes(get("--job"))).toString()) as MacRuntimeProductionJob;
        result = await produceMacRuntimeInputs(job, runBoundedAssetCli);
    } else if (command === "v1-inputs") {
        const job = JSON.parse((await inputBytes(get("--job"))).toString()) as RuntimeV1ProductionJob;
        result = await produceRuntimeV1(job, runBoundedAssetCli);
    } else if (command === "mac-stage") {
        const expected = JSON.parse((await inputBytes(get("--expected"))).toString()) as ExpectedPayloadInputs;
        result = await stageProducedMacRuntime(await inputBytes(get("--recipe")), expected,
            get("--input-root"), get("--output-parent"), get("--candidate"));
    } else {
        const mac = flags.has("--mac-policy") ? JSON.parse((await inputBytes(get("--mac-policy"))).toString()) as
            { arch: MacRuntimeArch; layout: MacChromeLayout } : undefined;
        result = await packageRuntimeCandidate({ runtimeDirectory: get("--runtime-root"), receiptPath: get("--receipt"),
            outputParent: get("--output-parent"), candidateName: get("--candidate"), ...(mac ? { mac } : {}) });
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
    const code = error instanceof Error && /^[A-Z][A-Z0-9_]{1,100}$/.test(error.message) ? error.message : "RUNTIME_BUILD_FAILED";
    process.stderr.write(`${code}; owned build evidence is retained; no release approval was granted\n`);
    process.exitCode = 1;
}
