import { basename, dirname, resolve } from "node:path";
import { verifyRuntimePayloadInputs, RuntimePayloadError } from "./runtime-payload-inputs.ts";
import { InputReader, decode } from "./runtime-payload-tree.ts";
import { checked, schemas } from "./runtime-payload-receipts.ts";

/**
 * inspect 只接受三个显式且不重复的参数，不从环境变量或隐式工作目录补选任何输入；成功只输出一份完整静态报告，失败仅输出
 * 固定英文分类，避免路径或 JSON 正文进入诊断。
 */
function flags(args) {
    const values = new Map();
    for (let index = 0; index < args.length; index += 2) {
        const name = args[index],
            value = args[index + 1];
        if (
            !["--inputs", "--expected", "--input-root"].includes(name) ||
            values.has(name) ||
            !value ||
            value.startsWith("--")
        )
            throw new RuntimePayloadError("PAYLOAD_INPUT_INVALID");
        values.set(name, value);
    }
    if (values.size !== 3) throw new RuntimePayloadError("PAYLOAD_INPUT_INVALID");
    return values;
}
/**
 * 信号处理与所有读取共享同一 AbortController，首次信号停止准入并等待 finally 关闭句柄；二次信号或五秒期限必须报告
 * INCOMPLETE，不声称关闭已确认，也绝不删除任何输入或转发给输入程序。
 */
const controller = new AbortController();
let signalExit = 0,
    timer;
const diagnostic = (code, cleanup) => process.stderr.write(`${code} phase=INPUTS cleanup=${cleanup}\n`);
const interrupt = (signal) => {
    const exit = signal === "SIGINT" ? 130 : 143;
    if (signalExit) {
        diagnostic("PAYLOAD_CANCELLED", "INCOMPLETE");
        process.exit(signalExit);
    }
    signalExit = exit;
    timer = setTimeout(() => {
        diagnostic("PAYLOAD_CANCELLED", "INCOMPLETE");
        process.exit(signalExit);
    }, 5000);
    controller.abort();
};
const onInt = () => interrupt("SIGINT"),
    onTerm = () => interrupt("SIGTERM");
process.on("SIGINT", onInt);
process.on("SIGTERM", onTerm);
/**
 * 外层两个 JSON 使用相同只读身份策略和四 MiB 上限，expected 由独立文件提供而不从 recipe 自生成；持有句柄的 reader 在每
 * 次读取后关闭自身资源，核心 verify 随后重新绑定所有真实输入。
 */
async function input(path) {
    const absolute = resolve(path),
        reader = new InputReader(dirname(absolute), controller.signal, []);
    await reader.initialize();
    const content = await reader.input(basename(absolute));
    await reader.finish();
    return content;
}
try {
    const values = flags(process.argv.slice(2));
    const recipeBytes = await input(values.get("--inputs"));
    const expected = checked(decode(await input(values.get("--expected"))), schemas.expected);
    const report = await verifyRuntimePayloadInputs(recipeBytes, expected, {
        inputRoot: values.get("--input-root"),
        signal: controller.signal,
    });
    if (controller.signal.aborted) throw new RuntimePayloadError("PAYLOAD_CANCELLED");
    process.stdout.write(`${JSON.stringify(report)}\n`);
} catch (error) {
    const known = error instanceof RuntimePayloadError ? error : new RuntimePayloadError("PAYLOAD_IO");
    diagnostic(known.code, known.cleanup);
    process.exitCode = signalExit || 1;
} finally {
    clearTimeout(timer);
    process.removeListener("SIGINT", onInt);
    process.removeListener("SIGTERM", onTerm);
}
