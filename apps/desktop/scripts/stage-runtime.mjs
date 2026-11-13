import { mkdir, copyFile, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";

/** Runtime 的在线与离线模块分别使用同目录和上级 execution 目录定位现有 worker，打包后 main 入口与 chunk 保持同级；这里只复制同一份受审源码，不创建新的执行器或动态代码入口。 */
const root = resolve("../runtime");
const files = [];
for (const target of ["out/main", "out/execution"]) {
    await mkdir(target, { recursive: true });
    for (const name of ["worker.mjs", "provider.mjs", "compile-entry.mjs", "archive.mjs"]) {
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
await mkdir("build", { recursive: true });
await copyFile(resolve(root, "build/veriq_runner"), resolve("build/veriq_runner"));
files.push({
    path: "build/veriq_runner",
    sha256: createHash("sha256")
        .update(await readFile("build/veriq_runner"))
        .digest("hex"),
});
await writeFile("out/runtime-files.json", JSON.stringify(files, null, 4) + "\n");
