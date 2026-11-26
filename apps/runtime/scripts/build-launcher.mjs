// 构建阶段使用 cc 把 Linux 启动辅助程序编译到发行所需的位置，安装后的 Agent 直接使用预编译文件。
import { mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
if (process.platform !== "linux") throw new Error("UNSUPPORTED_LAUNCHER_BUILD_PLATFORM");
const root = new URL("../", import.meta.url);
await mkdir(new URL("build/", root), { recursive: true });
execFileSync(
    "cc",
    [
        "-std=c11",
        "-O2",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-D_FORTIFY_SOURCE=2",
        "-fstack-protector-strong",
        "-Wl,-z,relro,-z,now",
        "-o",
        fileURLToPath(new URL("build/veriq_runner", root)),
        fileURLToPath(new URL("native/linux-runner.c", root)),
    ],
    { stdio: "inherit" },
);
