import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

/** GUI 输入清单只观察已经生成的本地资源并拒绝链接、特殊文件和大小写冲突，构建命令不凭一个 index.html 文件名接受其它缺失入口；完整摘要由外部期望独立绑定，扫描本身不产生批准或发布身份。
 * 独立 Node 角色不执行 Electron ASAR 内的文件，所以这里仅包括 GUI main/preload/renderer。
 * renderer 的所有 Monaco worker、字体和样式进入同一递归库存，安装后无需远程 CDN。
 * 每个文件按流计算摘要，固定数量和累计大小预算防止误把工作区或大缓存作为 GUI 输入。
 * inventory 文件位于 out 外以避免自引用，旧 runtime-files.json 仍属于 GUI 可读诊断材料。
 */
export async function desktopInventory(directory) {
    const root = resolve(directory);
    if (await realpath(root) !== root) throw new Error("DESKTOP_GUI_PATH_INVALID");
    /** 名称注册同时包含目录和文件，大小写冲突在任何目标上采用同一保守判断；扫描预算按实际遇到的成员累计，不能通过一棵空目录树或隐藏层级绕过资源数量限制。
     * root 必须先是规范物理路径，不接受链接目录作为可信构建根。
     * 文件结果保持确定排序，外部审核者可以精确绑定相同序列化字节。
     * 不扫描 root 之外的源码、缓存和依赖，不解析用户传入的任意资源 URL。
     * 只有最终强制入口存在后才返回摘要，空文件树不能成为候选 GUI。
     */
    const files = [];
    const names = new Map();
    let total = 0;
    async function walk(directory, prefix = "") {
        const children = (await readdir(directory)).sort();
        for (const name of children) {
            if (!name || /[\\:\x00-\x1f\x7f]/.test(name) || /[. ]$/.test(name))
                throw new Error("DESKTOP_GUI_PATH_INVALID");
            const path = prefix + name;
            const prior = names.get(path.toLowerCase());
            if (prior !== undefined) throw new Error("DESKTOP_GUI_COLLISION");
            names.set(path.toLowerCase(), path);
            if (names.size > 20000) throw new Error("DESKTOP_GUI_LIMIT");
            const absolute = join(directory, name);
            const before = await lstat(absolute);
            if (before.isSymbolicLink()) throw new Error("DESKTOP_GUI_LINK_FORBIDDEN");
            if (before.isDirectory()) await walk(absolute, path + "/");
            else {
                if (!before.isFile() || before.nlink !== 1) throw new Error("DESKTOP_GUI_TYPE_INVALID");
                total += before.size;
                if (total > 1024 * 1024 * 1024) throw new Error("DESKTOP_GUI_LIMIT");
                /** 文件按流读取并比较读取前后设备、inode、大小与时间，发现变化立即拒绝而不输出混合快照；单硬链接限制防止开发包缓存与输出共享同一个可修改物理成员，复制后的目标还会由打包入口复验。
                 * 此观察不是整个目录的原子快照，外部流程仍需保持构建输入静止。
                 * 不通过 rename 或 chmod 修复不合规输入，源材料始终保持只读。
                 * 一 GiB 总文件预算覆盖本地 UI，同时阻止误把完整浏览器放进 GUI 清单。
                 * 模式和原生可执行验证属于独立 Runtime 库存，不从这个清单推导角色能力。
                 */
                const hash = createHash("sha256");
                for await (const bytes of createReadStream(absolute)) hash.update(bytes);
                const after = await lstat(absolute);
                if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
                    throw new Error("DESKTOP_GUI_CHANGED");
                files.push({ path, sizeBytes: before.size, sha256: hash.digest("hex") });
            }
        }
    }
    await walk(root);
    /** 三个宿主入口、唯一 sandbox preload、本地 HTML 和许可材料都是不可缺少的真实输出；库存正文放在 out 外以免摘要自引用，renderer 所需 worker 与静态资源则自然包含在递归文件集合中。
     * 缺入口时直接失败，不生成只有版本号或目录名的空成功记录。
     * 不根据 package.json 的声明假设某个产物已经由 Vite 生成。
     * 内容摘要由标准 SHA256 提供，独立期望负责授权它而不是让扫描器自批准。
     * 结果不带 ready、签名或支持状态，安装验收仍是后续独立工作。
     */
    for (const required of ["main/index.js", "main/agent.js", "main/cli.js", "preload/index.cjs", "renderer/index.html", "LICENSE", "THIRD_PARTY_NOTICES.md"])
        if (!files.some((file) => file.path === required)) throw new Error("DESKTOP_GUI_ENTRY_MISSING");
    const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, files }) + "\n");
    return { bytes, sha256: createHash("sha256").update(bytes).digest("hex"), files };
}
