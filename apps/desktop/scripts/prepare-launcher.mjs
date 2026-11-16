import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** 开发 GUI 沿用既有 Linux guardian 的原生产者，而 Mac 与 Windows 的正式原生材料由独立 Runtime 生产入口提供；不在桌面构建中重复实现进程监督器，也不会在非 Linux 宿主调用明确拒绝该
 * 平台的 C 编译脚本。 */
if (process.platform === "linux") {
    execFileSync(
        process.execPath,
        [fileURLToPath(new URL("../../runtime/scripts/build-launcher.mjs", import.meta.url))],
        { stdio: "inherit" },
    );
}
