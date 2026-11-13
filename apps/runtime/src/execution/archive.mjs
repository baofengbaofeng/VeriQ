import { create, list, extract } from "tar";
import { lstat, readdir, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";

/** 引擎归档只允许普通文件与目录，路径在 Windows 和 Linux 都采用同一相对成员规则；即使归档已有发行哈希，也不能把符号链接、硬链接或特殊设备变成编译器目录中的可执行输入。 */
function member(entry) {
    const name = entry.path.replace(/\/$/, "");
    if (
        !name ||
        /[\\:\x00-\x1f]/.test(name) ||
        name.split("/").some((part) => !part || part === "." || part === "..") ||
        !["File", "Directory"].includes(entry.type)
    )
        throw new Error("UNSAFE_ENGINE_ARCHIVE");
    return name;
}

/** 解压先完整扫描大小、成员类型和重复路径，再使用同一已验证字节执行提取；文件内容来自宿主已核验的发行归档，禁止保留归档中的属主与危险权限，也不调用目标系统可能不存在的 tar 程序。 */
export async function extractCompiler(file, cwd) {
    const { readFile } = await import("node:fs/promises");
    const bytes = await readFile(file);
    if (bytes.length > 128 * 1024 * 1024) throw new Error("ENGINE_ARCHIVE_LIMIT");
    const seen = new Set();
    let total = 0;
    const inspect = list({
        strict: true,
        onReadEntry(entry) {
            const name = member(entry);
            if (seen.has(name) || seen.size >= 10000) throw new Error("UNSAFE_ENGINE_ARCHIVE");
            seen.add(name);
            total += entry.size;
            if (total > 128 * 1024 * 1024) throw new Error("ENGINE_ARCHIVE_LIMIT");
        },
    });
    await new Promise((resolve, reject) => {
        inspect.on("error", reject);
        inspect.on("end", resolve);
        inspect.end(bytes);
    });
    const unpack = extract({
        cwd,
        strict: true,
        preserveOwner: false,
        noChmod: true,
        noMtime: true,
    });
    await new Promise((resolve, reject) => {
        unpack.on("error", reject);
        unpack.on("close", resolve);
        unpack.end(bytes);
    });
}

/** 发行生产器按明确排序后的真实文件清单归档，固定时间并去掉平台属主元数据；递归过程拒绝源链接和特殊文件，确保同一输入不会由于宿主目录遍历顺序或用户名改变候选字节。 */
export async function archive(directory, members, destination) {
    const paths = [];
    async function visit(name) {
        const info = await lstat(join(directory, name));
        if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile()))
            throw new Error("UNSAFE_ENGINE_ARCHIVE");
        paths.push(name);
        if (info.isDirectory())
            for (const child of (await readdir(join(directory, name))).sort())
                await visit(name + "/" + child);
    }
    for (const name of [...members].sort()) await visit(name);
    await mkdir(dirname(destination), { recursive: true });
    await create(
        {
            cwd: directory,
            file: destination,
            gzip: true,
            portable: true,
            mtime: new Date(0),
            noPax: true,
            noDirRecurse: true,
        },
        paths,
    );
}
