import { readFile, realpath, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { resolve, relative, sep, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// 此脚本只在经过外层准入的目标 Node 中执行解析，不导入或运行任何候选包正文；两个真实 Node 解析器的结果分别记录，导出条
// 件指向不同物理实例时交给外层明确拒绝，不自行解析 exports。
const [root, requestPath, resultPath] = process.argv.slice(2);
if (
    !root ||
    !requestPath ||
    !resultPath ||
    !isAbsolute(root) ||
    resolve(root) !== root ||
    !isAbsolute(resultPath)
)
    throw new Error("Invalid resolver invocation");
const bytes = await readFile(requestPath);
if (bytes.length > 4 * 1024 ** 2) throw new Error("Resolver request limit");
const requests = JSON.parse(bytes);
if (!Array.isArray(requests) || requests.length > 20000) throw new Error("Resolver request limit");
const resolutions = [];
for (const request of requests) {
    if (
        typeof request.consumer !== "string" ||
        typeof request.specifier !== "string" ||
        !request.specifier ||
        request.specifier.startsWith(".") ||
        request.specifier.includes(":")
    )
        throw new Error("Invalid resolver request");
    const full = resolve(root, request.consumer),
        rel = relative(root, full);
    if (rel.startsWith(".." + sep) || rel === ".." || isAbsolute(rel))
        throw new Error("Resolver consumer escaped root");
    const parent = pathToFileURL(full).href;
    const result = {
        consumer: request.consumer,
        specifier: request.specifier,
        import: null,
        require: null,
    };
    // import.meta.resolve 使用 Node24 的真实 ESM 条件和明确父 URL，createRequire 则覆盖真实 CommonJS 条件；只把标准的未
    // 找到或未导出作为解析缺失，I/O 与其它内部错误始终
    // 终止本次有界动作。
    for (const mode of ["import", "require"]) {
        try {
            const value =
                mode === "import"
                    ? import.meta.resolve(request.specifier, parent)
                    : pathToFileURL(createRequire(parent).resolve(request.specifier)).href;
            if (!value.startsWith("file:")) throw new Error("Non-file resolution");
            const path = await realpath(fileURLToPath(value)),
                output = relative(root, path);
            if (output === ".." || output.startsWith(".." + sep) || isAbsolute(output))
                throw new Error("Resolved file escaped root");
            result[mode] = { path: output.split(sep).join("/"), error: null };
        } catch (error) {
            if (
                ![
                    "ERR_MODULE_NOT_FOUND",
                    "MODULE_NOT_FOUND",
                    "ERR_PACKAGE_PATH_NOT_EXPORTED",
                    "ENOENT",
                ].includes(error?.code)
            )
                throw error;
            result[mode] = { path: null, error: error.code };
        }
    }
    resolutions.push(result);
}
const executable = await realpath(process.execPath);
const executableHash = createHash("sha256");
for await (const chunk of createReadStream(executable)) executableHash.update(chunk);
const executableSha256 = executableHash.digest("hex");
const output = Buffer.from(
    JSON.stringify({
        nodeVersion: process.versions.node,
        electronVersion: process.versions.electron ?? null,
        platform: process.platform,
        arch: process.arch,
        executable,
        executableSha256,
        resolutions,
    }),
);
if (output.length > 4 * 1024 ** 2) throw new Error("Resolver result limit");
await writeFile(resultPath, output, { flag: "wx", mode: 0o600 });
process.stdout.write(
    JSON.stringify({
        sizeBytes: output.length,
        sha256: createHash("sha256").update(output).digest("hex"),
    }),
);
