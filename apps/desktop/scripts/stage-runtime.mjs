import { mkdir, copyFile, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { desktopInventory } from "./desktop-inventory.mjs";

/** Runtime 的在线与离线模块分别使用同目录和上级 execution 目录定位现有 worker，打包后 main 入口与 chunk 保持同级；这里只复制同一份受审源码，不创建新的执行器或动态代码入口。 */
const root = resolve("../runtime");
const files = [];
for (const target of ["out/main", "out/execution"]) {
    await mkdir(target, { recursive: true });
    for (const name of [
        "worker.mjs",
        "provider.mjs",
        "compile-entry.mjs",
        "archive.mjs",
        "controlled-command.mjs",
        "controlled-child.mjs",
        "controlled-child-protocol.mjs",
        "controlled-child-preload.mjs",
    ]) {
        const source = resolve(root, "src/execution", name);
        await copyFile(source, resolve(target, name));
        files.push({
            path: target + "/" + name,
            sha256: createHash("sha256")
                .update(await readFile(source))
                .digest("hex"),
        });
    }
}
if (process.platform === "linux" && !process.argv.includes("--gui-only")) {
    await mkdir("build", { recursive: true });
    await copyFile(resolve(root, "build/veriq_runner"), resolve("build/veriq_runner"));
    files.push({
        path: "build/veriq_runner",
        sha256: createHash("sha256")
            .update(await readFile("build/veriq_runner"))
            .digest("hex"),
    });
}
await writeFile("out/runtime-files.json", JSON.stringify(files, null, 4) + "\n");

/** 产品许可与第三方声明必须随实际本地 GUI 字节进入同一可审阅库存，而不能只留在开发 checkout；复制后由外部 GUI 摘要绑定，后续许可和 SBOM 门禁仍须核对真实目标依赖，不把存在文本当作许可审计已经通过。 */
await copyFile(resolve("../../LICENSE"), resolve("out/LICENSE"));
await copyFile(resolve("../../THIRD_PARTY_NOTICES.md"), resolve("out/THIRD_PARTY_NOTICES.md"));

/** 本地 GUI 的字节清单在所有现有 worker 复制完成后产生，并放在 out 外避免自身摘要递归；这只供独立审核绑定真实构建输入，安装器必须拿外部期望对比而不能把本次自报摘要自动当成批准。 */
const inventory = await desktopInventory("out");
await writeFile("desktop-inventory.json", inventory.bytes);
