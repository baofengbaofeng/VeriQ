/** Windows 原生构建是显式开发步骤，binding.gyp 放在 native 子目录避免依赖安装时隐式编译；目标流水线使用已锁定 node-gyp 与官方 Node 头文件，成功后只把两个本次产物复制到 Runtime 开发布局供真实角色测试。 */
import { execFileSync } from "node:child_process";
import { copyFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") throw new Error("WINDOWS_NATIVE_BUILD_REQUIRED");
if (
    process.argv.length > 4 ||
    (process.argv[3] !== undefined && process.argv[3] !== "--test-schedules")
)
    throw new Error("NATIVE_BUILD_ARGUMENTS_INVALID");
const testSchedules = process.argv[3] === "--test-schedules";
const root = new URL("../", import.meta.url);
const options = [
    "rebuild",
    "--msvs_version=2022",
    "--directory",
    fileURLToPath(new URL("native/", root)),
];
if (process.argv[2]) options.push(`--devdir=${process.argv[2]}`);
/** 正式构建显式关闭调度测试目标，只有命令行专用参数可编译独立测试二进制；该开关不修改生产 guardian 或 addon 的源码和导出，也不会读取全局环境变量来赋予运行时调度能力。 */
options.push("--", `-Dveriq_native_tests=${testSchedules ? 1 : 0}`);
execFileSync(
    process.execPath,
    [fileURLToPath(new URL("node_modules/node-gyp/bin/node-gyp.js", root)), ...options],
    { stdio: "inherit" },
);
await mkdir(new URL("build/Release/", root), { recursive: true });
for (const name of ["veriq_native.node", "veriq_guardian.exe"]) {
    await copyFile(
        new URL(`native/build/Release/${name}`, root),
        new URL(`build/Release/${name}`, root),
    );
}
if (testSchedules) {
    await mkdir(new URL("build/native-tests/", root), { recursive: true });
    for (const name of ["veriq_test_schedule.node", "veriq_guardian_scheduled.exe"]) {
        await copyFile(
            new URL(`native/build/Release/${name}`, root),
            new URL(`build/native-tests/${name}`, root),
        );
    }
}
