import { basename, dirname, isAbsolute } from "node:path";
import { RuntimePayloadError } from "./runtime-payload-inputs.ts";
import { prepareMacNodeBootstrap } from "./runtime-node-bootstrap.ts";
import { emitArchiveFailure } from "./runtime-payload-archive.ts";
import { InputReader } from "./runtime-payload-tree.ts";

/**
 * 资产工具只接受冻结的显式且各出现一次的参数，所有宿主路径必须绝对而候选名由核心入口核可移植规则；不从环境变量、网络或
 * 隐式工作目录补齐来源，成功 stdout 只包含完整封存结果 JSON，诊断只用稳定英文分类。
 */
function flags(args) {
    const names = ["--assets", "--input-root", "--output-parent", "--candidate"],
        values = new Map();
    for (let index = 0; index < args.length; index += 2) {
        const name = args[index],
            value = args[index + 1];
        if (
            !names.includes(name) ||
            values.has(name) ||
            !value ||
            value.startsWith("--") ||
            (name !== "--candidate" && !isAbsolute(value))
        )
            throw new RuntimePayloadError("PAYLOAD_INPUT_INVALID");
        values.set(name, value);
    }
    if (values.size !== names.length) throw new RuntimePayloadError("PAYLOAD_INPUT_INVALID");
    return values;
}
/**
 * 外层输入 JSON 复用原 reader 的 held FD、无链接祖先、四 MiB 实际长度与身份收尾策略，不另造宽松解析；核心入口随后同步复
 * 制字节并核固定来源与身份，外层读取不授予后续执行或布局信任。
 */
async function input(path) {
    const reader = new InputReader(dirname(path), controller.signal, []);
    await reader.initialize();
    const bytes = await reader.input(basename(path));
    await reader.finish();
    return bytes;
}
/**
 * 信号处理只取消当前自有文件与流，首个信号启动五秒关闭期限，二次信号或期限到达明确报告 INCOMPLETE；CLI 不执行或转发信号
 * 给任何归档程序，SIGKILL 和断电不属于可确认清理范围，未确认 writer 的目录保留。
 */
const controller = new AbortController();
let exit = 0,
    timer;
const diagnostic = (code, phase, cleanup) => process.stderr.write(`${code} phase=${phase} cleanup=${cleanup}\n`);
const interrupt = (number) => {
    if (exit) {
        diagnostic("PAYLOAD_CANCELLED", "UNKNOWN", "INCOMPLETE");
        process.exit(exit);
    }
    exit = number;
    timer = setTimeout(() => {
        diagnostic("PAYLOAD_CANCELLED", "UNKNOWN", "INCOMPLETE");
        process.exit(exit);
    }, 5000);
    controller.abort();
};
const sigint = () => interrupt(130),
    sigterm = () => interrupt(143);
process.on("SIGINT", sigint);
process.on("SIGTERM", sigterm);
try {
    const values = flags(process.argv.slice(2));
    const bytes = await input(values.get("--assets"));
    const result = await prepareMacNodeBootstrap(bytes, {
        inputRoot: values.get("--input-root"),
        outputParent: values.get("--output-parent"),
        candidateName: values.get("--candidate"),
        signal: controller.signal,
    });
    if (result.cleanup === "INCOMPLETE") diagnostic("PAYLOAD_CLEANUP_INCOMPLETE", "PUBLISH", "INCOMPLETE");
    if (controller.signal.aborted) diagnostic("PAYLOAD_COMMITTED_BEFORE_CANCELLATION", "PUBLISH", result.cleanup);
    process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
    const known = error instanceof RuntimePayloadError ? error : new RuntimePayloadError("PAYLOAD_IO");
    emitArchiveFailure(known, exit || 1);
} finally {
    clearTimeout(timer);
    process.removeListener("SIGINT", sigint);
    process.removeListener("SIGTERM", sigterm);
}
