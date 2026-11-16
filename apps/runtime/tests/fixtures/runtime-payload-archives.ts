import { execFileSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import { Header, type HeaderData } from "tar";
import { model, hash, bytes } from "./runtime-payload.ts";
import type { Arch } from "../../scripts/runtime-payload-inputs.ts";

/** 真实归档测试保留原始路径、类型、权限和小正文作为独立期望，畸形案例可只替换一个字段；这些字节从不作为程序执行，Python 标准库仅负责开发测试生成 ZIP 而非产品运行依赖。 */
export type ArchiveFixtureEntry = {
    path: string;
    kind?: "file" | "directory" | "link";
    body?: string;
    mode?: number;
    target?: string;
    type?: HeaderData["type"];
    declaredSize?: number;
};
/** tar 夹具使用已锁成熟 Header 编码器生成真正的五百一十二字节帧，再交 Node gzip 产生可校验 trailer；允许小声明补丁构造拒绝案例，不在产品实现自造归档或解压算法。 */
export function tarBytes(entries: readonly ArchiveFixtureEntry[], tail = Buffer.alloc(1024)) {
    const blocks: Buffer[] = [];
    for (const entry of entries) {
        const body = Buffer.from(entry.body ?? "");
        const header = new Header({
            path: entry.path,
            type:
                entry.type ??
                (entry.kind === "directory"
                    ? "Directory"
                    : entry.kind === "link"
                      ? "SymbolicLink"
                      : "File"),
            mode:
                entry.mode ??
                (entry.kind === "link" ? 0o777 : entry.kind === "directory" ? 0o755 : 0o644),
            size: entry.declaredSize ?? body.length,
            linkpath: entry.target ?? "",
            uid: 0,
            gid: 0,
            mtime: new Date(0),
        });
        const raw = Buffer.alloc(512);
        header.encode(raw);
        blocks.push(raw, body, Buffer.alloc((512 - (body.length % 512)) % 512));
    }
    return gzipSync(Buffer.concat([...blocks, tail]));
}
/** ZIP 夹具沿用仓库 Python zipfile 模式并只向解释器标准输入传递小 JSON，输出真实 stored 或 deflate 内容；Unix 类型和权限写入公开 external_attr，使产品必须真正读取链接正
 * 文与 CRC 而非信任 DTO。 */
export function zipBytes(entries: readonly ArchiveFixtureEntry[], compression = 8) {
    return execFileSync(
        "python3",
        [
            "-c",
            `import io,json,sys,zipfile,warnings
warnings.filterwarnings("ignore",category=UserWarning,module="zipfile")
v=json.load(sys.stdin)
b=io.BytesIO()
with zipfile.ZipFile(b,'w',compression=v['compression']) as z:
    for e in v['entries']:
        k=e.get('kind','file')
        i=zipfile.ZipInfo(e['path'])
        i.create_system=3
        i.compress_type=v['compression']
        mode=e.get('mode',0o777 if k=='link' else 0o755 if k=='directory' else 0o644)
        i.external_attr=((0o120000 if k=='link' else 0o040000 if k=='directory' else 0o100000)|mode)<<16
        if k=='directory': i.external_attr|=0x10
        z.writestr(i,e.get('target','') if k=='link' else e.get('body',''))
sys.stdout.buffer.write(b.getvalue())`,
        ],
        {
            input: JSON.stringify({ entries, compression }),
            maxBuffer: 1024 ** 2,
        },
    );
}
/** 实际 intake 模型以两份微型真实归档替换旧占位正文，同时重新绑定各收据、独立布局及原配方摘要；所有其它五树来源仍复用已验夹具，使两个架构都必须先通过真实 b1a 而非绕过准入。 */
export function archiveModel(arch: Arch = "x64") {
    const value = model(arch),
        nodeTop = value.recipe.node.topDirectory,
        chromeTop = value.recipe.chrome.topDirectory;
    const framework = `${chromeTop}/Google Chrome for Testing.app/Contents/Frameworks/Test.framework`;
    const nodeEntries: ArchiveFixtureEntry[] = [
        { path: `${nodeTop}/bin/node`, body: "synthetic Node binary", mode: 0o755 },
        {
            path: `${nodeTop}/lib/node_modules/npm/package.json`,
            body: JSON.stringify({ name: "npm", version: "11.0.0" }),
        },
        { path: `${nodeTop}/lib/node_modules/npm/bin/npm-cli.js`, body: "export {};\n" },
        {
            path: `${nodeTop}/bin/npm`,
            kind: "link",
            target: "../lib/node_modules/npm/bin/npm-cli.js",
        },
        { path: `${nodeTop}/LICENSE`, body: "synthetic Node license" },
    ];
    const chromeEntries: ArchiveFixtureEntry[] = [
        {
            path: `${chromeTop}/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
            body: "synthetic Chrome binary",
            mode: 0o755,
        },
        { path: `${framework}/Versions/A/Test`, body: "framework binary", mode: 0o755 },
        { path: `${framework}/Versions/Current`, kind: "link", target: "A" },
        { path: `${framework}/Test`, kind: "link", target: "Versions/Current/Test" },
        { path: `${chromeTop}/LICENSE`, body: "synthetic browser license" },
    ];
    value.nodeReceipt.inputLinks = nodeEntries
        .filter((e) => e.kind === "link")
        .map((e) => ({ path: e.path, target: e.target! }));
    value.chromeLayout.layout.frameworkRoots = [`browser/${framework}`];
    value.chromeLayout.layout.allowedLinks = chromeEntries
        .filter((e) => e.kind === "link")
        .map((e) => ({ path: `browser/${e.path}`, target: e.target! }));
    const bind = (node = tarBytes(nodeEntries), chrome = zipBytes(chromeEntries)) => {
        Object.assign(value.recipe.node.file, value.put(value.recipe.node.file.path, node));
        Object.assign(value.recipe.chrome.file, value.put(value.recipe.chrome.file.path, chrome));
        value.nodeReceipt.archiveSha256 = hash(node);
        for (const instance of value.nodeReceipt.npmGraph.instances)
            instance.lockSnapshot = `node-archive:${hash(node)}:.`;
        const npm = Buffer.from(
            nodeEntries.find((e) => e.path.endsWith("/npm/package.json"))!.body!,
        );
        Object.assign(value.nodeReceipt.npmPackageJson, {
            sizeBytes: npm.length,
            sha256: hash(npm),
        });
        value.chromeReceipt.archiveSha256 = hash(chrome);
        value.chromeLayout.archiveSha256 = hash(chrome);
        const layoutHash = hash(bytes(value.chromeLayout));
        value.chromeReceipt.layoutSha256 = layoutHash;
        value.expected.chromeLayoutSha256 = layoutHash;
        return value.seal();
    };
    bind();
    return { ...value, nodeEntries, chromeEntries, bind };
}
