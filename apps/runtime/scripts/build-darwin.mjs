/** Darwin 私有文件构建只在真实 Mac 显式执行，使用仓库已锁 node-gyp 和独立 gyp 图，不触发 Windows guardian 或安装期编译；头文件缓存必须由命令行明确指定且故障目标仅由专用参数启用。
 * 构建不读取产品环境变量以打开故障能力，正式产物与测试产物始终分开复制。
 * Darwin 输出使用独立目录，不覆盖已有 Windows build/Release 库存名称。
 * macOS 最低版本、异常与 C++ 标准由独立 gyp 设置，实际编译输入另由目标 CI 留证。
 */
import { execFileSync } from "node:child_process";
import { copyFile, mkdir } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 参数只允许一个明确绝对缓存目录与可选独立测试开关，pnpm 传来的单个分隔符在解析前移除；拒绝多余参数以免把拼写错误静默解释成正式构建或把 header 下载到本地默认全局缓存。
 * 缓存路径只用于构建工具，不能变成产品原生模块搜索路径。
 * 非 Mac 宿主在任何目录创建和 node-gyp 调用前拒绝，不下载 Darwin headers 到 Linux。
 */
if (process.platform !== "darwin") throw new Error("DARWIN_NATIVE_BUILD_REQUIRED");
const args = process.argv.slice(2);
if (args[0] === "--") args.shift();
if (
    args.length < 1 || args.length > 2 || !isAbsolute(args[0]) ||
    (args[1] !== undefined && args[1] !== "--test-schedules")
) throw new Error("DARWIN_NATIVE_BUILD_ARGUMENTS_INVALID");
const root = new URL("../", import.meta.url);
const tests = args[1] === "--test-schedules";
const headers = resolve(args[0]);
const native = new URL("native/darwin/", root);

/** 原生调用采用参数数组且明确独立目录和 header 缓存，测试开关只决定是否构建额外 addon；正式代码没有测试宏，后续加载器也只寻找正式 Darwin 产物，不会把测试二进制作为回退。
 * 继承标准输出保留真实 clang/node-gyp 错误，失败不复制旧成功产物冒充本轮输出。
 * Node 头文件下载只发生在 CI 已分配的真实 Mac 构建环境。
 * 缓存由 runner-temp 显式传入，安装过程中不会自动执行本脚本。
 * node-gyp 的所有非零结果阻止后续复制，不把旧构建输出当作当前成功。
 * testSchedules 只作为 gyp 变量，不传入产品运行环境。
 */
await mkdir(headers, { recursive: true, mode: 0o700 });
execFileSync(process.execPath, [
    fileURLToPath(new URL("node_modules/node-gyp/bin/node-gyp.js", root)),
    "rebuild", "--directory", fileURLToPath(native), `--devdir=${headers}`,
    "--", `-Dveriq_native_tests=${tests ? 1 : 0}`,
], { stdio: "inherit" });

/** 只有本次 node-gyp 完整成功后才复制明确目标名单，正式与故障 addon 分别拥有固定开发位置；不复制其他平台构建目录、未知文件或 headers，也不赋予此开发输出安装库存的可信身份。
 * 对应双架构 CI 仍须实际加载并运行行为测试，文件复制成功不等于功能通过。
 * 生产 addon 路径不会因测试开关改变，避免正式消费者意外依赖测试导出。
 */
await mkdir(new URL("build/darwin/", root), { recursive: true });
await copyFile(new URL("build/Release/veriq_private_files.node", native),
    new URL("build/darwin/veriq_private_files.node", root));
if (tests) {
    await mkdir(new URL("build/native-tests/", root), { recursive: true });
    await copyFile(new URL("build/Release/veriq_private_files_fault.node", native),
        new URL("build/native-tests/veriq_private_files_fault.node", root));
}
