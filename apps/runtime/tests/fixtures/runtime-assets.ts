import "../../scripts/runtime-payload-inputs.ts";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ASSET_SOURCES, type SourceFacts } from "../../scripts/runtime-assets-observation.ts";
import type { Ref } from "../../scripts/runtime-payload-inputs.ts";
import { tarBytes, zipBytes } from "./runtime-payload-archives.ts";

/**
 * 微型夹具只为真实扫描器和流校验器提供可独立计算的普通字节，从不将它们伪装成固定官方归档；来源清单始终读取真实十九个宿
 * 主文件并复制其原字节，测试不会改动仓库源码或官方摘要。
 */
export function fact(path: string, bytes: Uint8Array): Ref {
    return {
        path,
        sizeBytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
    };
}
/**
 * 每个测试独占两个互不覆盖的私有目录，源清单及证据都使用真实六百权限普通文件；finally 只清除本次夹具的目录，未知事务资
 * 源必须先由测试明确结束后才能进入夹具收尾。
 */
export async function assetsFixture<T>(
    run: (value: {
        root: string;
        output: string;
        source: { commit: string; evidence: Ref };
        facts: SourceFacts;
    }) => Promise<T>,
) {
    const base = await mkdtemp(join(tmpdir(), "veriq-assets-")),
        root = join(base, "input"),
        output = join(base, "output");
    await mkdir(root, { mode: 0o700 });
    await mkdir(output, { mode: 0o700 });
    await mkdir(join(root, "evidence"), { mode: 0o700 });
    try {
        const files: Ref[] = [];
        for (const source of ASSET_SOURCES) {
            const bytes = await readFile(fileURLToPath(source.url));
            files.push(fact(source.path, bytes));
            const copy = join(root, "code", source.path);
            await mkdir(join(copy, ".."), { recursive: true, mode: 0o700 });
            await writeFile(copy, bytes, { mode: 0o600 });
        }
        const facts: SourceFacts = {
            schemaVersion: 1,
            kind: "ASSET_OBSERVER_SOURCE",
            commit: "a".repeat(40),
            runId: "123",
            runAttempt: 1,
            arch: "x64",
            osVersion: "15.7.1",
            nodeVersion: "24.22.1",
            nodeSha256: fact("node", Buffer.from("observed developer tool identity")).sha256,
            files,
        };
        const bytes = Buffer.from(JSON.stringify(facts));
        await writeFile(join(root, "evidence/source.json"), bytes, { mode: 0o600 });
        return await run({
            root,
            output,
            facts,
            source: { commit: facts.commit, evidence: fact("evidence/source.json", bytes) },
        });
    } finally {
        await rm(base, { recursive: true, force: true });
    }
}
/**
 * 两种归档均由已锁 tar 编码器及成熟 Python zipfile 生成真实压缩体，Framework 和外部链接特意同时存在以检验候选分类；归
 * 档成员不会被落地提取或作为 Node、Chrome 及其它目标程序执行。
 */
export function tinyAssets(arch: "x64" | "arm64" = "x64") {
    const nodeTop = `node-v24.22.1-darwin-${arch}`,
        chromeTop = `chrome-mac-${arch}`;
    const bundle = `${chromeTop}/Google Chrome for Testing.app`,
        framework = `${bundle}/Contents/Frameworks/Tiny.framework`;
    return [
        tarBytes([{ path: `${nodeTop}/bin/node`, body: "tiny observed bytes", mode: 0o755 }]),
        zipBytes([
            {
                path: `${bundle}/Contents/MacOS/Google Chrome for Testing`,
                body: "tiny browser bytes",
                mode: 0o755,
            },
            { path: `${framework}/Versions/A/Tiny`, body: "tiny framework" },
            { path: `${framework}/Versions/Current`, kind: "link", target: "A" },
            { path: `${chromeTop}/outside`, kind: "link", target: "LICENSE" },
            { path: `${chromeTop}/LICENSE`, body: "tiny license" },
        ]),
    ] as const;
}

/**
 * 工作流回归通过已锁开发环境中的成熟 PyYAML 读取实际提交的 YAML，而不是另写解析器或复制生产收集算法；缓存固定在测试自
 * 有目录并显式 offline/no-sync，不安装依赖，也不将 Python 变成资产工具运行时
 * 的产品依赖。
 */
export function assetWorkflowSteps(cacheRoot: string): readonly Record<string, unknown>[] {
    const project = fileURLToPath(new URL("../../../srv", import.meta.url));
    const workflow = fileURLToPath(
        new URL("../../../../.github/workflows/runtime-payload-macos.yml", import.meta.url),
    );
    const result = execFileSync(
        "uv",
        [
            "run",
            "--offline",
            "--no-sync",
            "--project",
            project,
            "python",
            "-c",
            'import json,sys,yaml; assert yaml.__version__ == "6.0.3"; print(json.dumps(yaml.safe_load(open(sys.argv' +
                '[1]))["jobs"]["assets"]["steps"]))',
            workflow,
        ],
        {
            encoding: "utf8",
            maxBuffer: 1024 ** 2,
            env: { ...process.env, UV_CACHE_DIR: cacheRoot },
        },
    );
    return JSON.parse(result) as Record<string, unknown>[];
}

const officialChecksumText =
    `f627b6d079829e648a4b800ffa889d37dbe23913507030030db85aa861591a26  node-v24.22.1-aix-ppc` +
    `64.tar.gz
5faf40b7cba01eba47dfff7b5322979f27d0e8f042bab96cc567a3df01ec9796  node-v24.22.1-arm64.msi
89c682593d76cd44233fa53b1563264e7de9cbb189cad169135c5b4fadfbc0a7  node-v24.22.1-darwin-arm64.tar.gz
654ba79de6155647e22321932b45f2a1ccb705976cc337c9b8e278beb085a628  node-v24.22.1-darwin-arm64.tar.xz
d132557e7ee2b85af08b0c8c34338e65c6430f2238d01f727728ef42dc83b035  node-v24.22.1-darwin-x64.tar.gz
65e450f90a6eaacd5000f611861c4ce65fadc87f813795dc4ed0c0e5f2fca2d4  node-v24.22.1-darwin-x64.tar.xz
322e0a27db9088093ab8347bdc8c7e0aaa21dc9ed548390bf06b394494c09267  node-v24.22.1-headers.tar.gz
33bf331af1c9812d25f82efb53de793b36b54c23b8ad49652c4325bbe7f98216  node-v24.22.1-headers.tar.xz
33c37be234ba8bee041961047b19160f4d7d0f164e8e246f78bdd10feff148b3  node-v24.22.1-linux-arm64.tar.gz
dbabf7a1cbf947e6059ffad2c27b80041db97dea1e553b62afdee7f13fca336e  node-v24.22.1-linux-arm64.tar.xz
9ce5728445016b29e49ad098f7a336061aa5f770d177d927278bc26fd626e643  node-v24.22.1-linux-ppc64le.tar.gz
5939d9e66b5a7e58c97f2a287787c5151147f33d43c41ad3261254b148374fdf  node-v24.22.1-linux-ppc64le.tar.xz
71979aeb1c385bc8ee83100d383a3b1ec0a5202e03df9f996a70403309caffb5  node-v24.22.1-linux-s390x.tar.gz
339aa21a40c321a2af55b7f7547117250b3d6f8149568bca59b5e17c2931ac22  node-v24.22.1-linux-s390x.tar.xz
9b250d29d6ab8ae38dd23019e2c04a6d6b2916ab1dad721c5f6e1da2b2901c6a  node-v24.22.1-linux-x64-musl.tar.gz
b83b6d679e4bf1128c8e9e982f3e64cd8badaddf1e38613aa36f93186395f9fa  node-v24.22.1-linux-x64-musl.tar.xz
eb6728e77c576a35162c122c45ccadf224d89ff00abc8dae46cc2897c6002d7c  node-v24.22.1-linux-x64.tar.gz
6c172a9ab6718f7b801fb5a7bd486af2ee5e32758086a04b84fcce2aa77095e6  node-v24.22.1-linux-x64.tar.xz
ca7618402754944626787fca386c406a041541f097da172e92348d8b1e44e48b  node-v24.22.1.pkg
001773d9bd53fbd27a25efd42aa6a9693ebfe500998ca9bec635e9b6ee79bc91  node-v24.22.1.tar.gz
4f5379796280cdaeb0c2f358fd04b6a16cc4fb7dfa83b5a8c91a9d963b435231  node-v24.22.1.tar.xz
aa26929d4ca7754aac3bd7fd018eb5c1c7961d00adf8aebf35c435d66edef62e  node-v24.22.1-win-arm64.7z
a0c807319fede24c4a0d8f84564c82a619bd313b16b10c007c383c2609e99171  node-v24.22.1-win-arm64.zip
bf9245db3a3bb281da45fee3974a74403687ea6030587bee4fd992efc822c35c  node-v24.22.1-win-x64.7z
d2046d28c2c3dcd211ac5145c0bf30e2047ef9dfb306693c8c6e2eccd8b95fa5  node-v24.22.1-win-x64.zip
3bda4baf1ee709b33cf920dd633106ddb23951e322bff9c03ec9f64ab8981b01  node-v24.22.1-x64.msi
8bea91dc437fe01e7d92ef0efc6c9eaf654369aaba9b2d3e9841552ea7b95a00  win-arm64/node.exe
2c0c3215d59c09d7c136da4949696dae121a299e9bdfc64cd9130a58610af63d  win-arm64/node.lib
ba8f5888df95f14c9de399863d2f8be82f05b4ad40d6ac390c00c8027c755486  win-arm64/node_pdb.7z
60f345bf8f9cbbfce57a97ebccd11433356bbb6f39ecbd23ca2eb51c6303a180  win-arm64/node_pdb.zip
d702daa815eabbff763c7d3808e235cf031cf2ca70211b56847bc72f51e240e5  win-x64/node.exe
a0a84aa03917b578d286010b7521837e9ff1136ffb2e4a406c14316c33fd06f7  win-x64/node.lib
75653d93bc58a9ae2d6bd419130126d881e27f804fd9e2cd0356696fe1f1a328  win-x64/node_pdb.7z
d61a585824e5504e1dfa0ceb7ad6981176f59531500303a97b790ccfe248a2c1  win-x64/node_pdb.zip
`;

/**
 * 已保存的官方校验文本以完整三千一百七十一原字节进入提交夹具，调用者每次获得独立可变副本而不会污染下一次核验；此材料只
 * 支持固定 HTTPS 文本一致性测试，不提供发布签名、目标归档正文或任何网络获取行为。
 */
export function officialNodeChecksumFixture(): Buffer {
    return Buffer.from(officialChecksumText, "ascii");
}
