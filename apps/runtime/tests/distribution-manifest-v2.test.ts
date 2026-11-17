import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { chmod, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import {
    MAC_RUNTIME_MANIFEST_V2_LIMITS as limits,
    MacRuntimeManifestError,
    parseMacRuntimeManifestV2 as parse,
    verifyMacRuntimeManifestV2 as verify,
    type MacChromeLayout,
    type MacRuntimeArch,
    type MacRuntimeManifestV2,
    type RuntimeLinkV2,
} from "../src/distribution-manifest-v2.ts";

/**
 * 测试使用明显标记的合成字节构造普通文件树，只验证跨宿主静态库存合同而不声称它们是 Mac 可执行程序；布局框架名称同样是
 * 虚构输入，不能作为正式 Chrome 归档的来源证据。
 */
function model(arch: MacRuntimeArch = "x64", frameworkCount = 0) {
    const bundlePath = `browser/chrome-mac-${arch}/Google Chrome for Testing.app`;
    const executablePath = `${bundlePath}/Contents/MacOS/Google Chrome for Testing`;
    const roots = Array.from(
        { length: frameworkCount },
        (_, i) => `${bundlePath}/Contents/Frameworks/Synthetic${i}.framework`,
    );
    const layout: MacChromeLayout = {
        bundlePath,
        executablePath,
        frameworkRoots: roots,
        allowedLinks: [],
    };
    const paths = [
        "roles/agent/veriq_agent",
        "roles/cli/veriq_cli",
        "roles/runner/veriq_runner",
        "entry/agent.js",
        "entry/cli.js",
        "npm/bin/npm-cli.js",
        "node_modules/tsx/dist/loader.mjs",
        "engines/1.0.0/inventory.json",
        "native/veriq_private_files.node",
        "native/vault/veriq_agent",
        executablePath,
        ...[
            "worker",
            "provider",
            "compile-entry",
            "archive",
            "controlled-command",
            "controlled-child",
            "controlled-child-protocol",
            "controlled-child-preload",
        ].map((name) => `execution/${name}.mjs`),
    ];
    const manifest: MacRuntimeManifestV2 = {
        schemaVersion: 2,
        platform: "darwin",
        arch,
        productVersion: "1.0.0-dev",
        nodeVersion: "24.22.1",
        engineVersion: "1.0.0",
        browser: { version: "158.0.8127.18", revision: "1254", bundlePath, executablePath },
        directories: [],
        files: [],
        links: [],
    };
    const data = new Map<string, Buffer>();
    for (const path of paths)
        addFile(
            manifest,
            data,
            path,
            path.startsWith("roles/") || path === executablePath || path === "native/vault/veriq_agent" ? 0o755 : 0o644,
        );
    for (const root of roots) addDirectory(manifest, root);
    return { manifest, data, expected: { arch, layout } };
}

/**
 * 父目录必须显式进入清单，测试辅助函数与产品解析器独立维护真实目录闭包；增加空目录也会保留记录，用来捕获忽略物理空目录
 * 或把链接别名当成真实父目录的实现错误。
 */
function addDirectory(manifest: MacRuntimeManifestV2, path: string) {
    if (path === "." || manifest.directories.includes(path)) return;
    addDirectory(manifest, dirname(path));
    manifest.directories.push(path);
}

/**
 * 合成文件摘要由测试准备阶段独立计算，后续真实树核验必须重新读取相同字节而不能信任测试传入的元数据；权限使用明确的十进
 * 制值，避免宿主默认权限掩盖执行成员的约束。
 */
function addFile(
    manifest: MacRuntimeManifestV2,
    data: Map<string, Buffer>,
    path: string,
    mode = 0o644,
    value = Buffer.from(`synthetic inventory bytes: ${path}`),
) {
    addDirectory(manifest, dirname(path));
    data.set(path, value);
    manifest.files.push({
        path,
        mode,
        sizeBytes: value.length,
        sha256: createHash("sha256").update(value).digest("hex"),
    });
}

/**
 * 每个物理场景独占一个含中文和空格的真实临时根，并在 finally 中清理全部自有成员；几兆字节流测试也复用该生命周期，不安
 * 装依赖、不运行浏览器、不留下大量持久缓存。
 */
async function tree(
    run: (value: ReturnType<typeof model> & { root: string; save: () => Promise<void> }) => Promise<unknown>,
    source = model(),
) {
    const root = await mkdtemp(join(tmpdir(), "veriq inventory 中文 "));
    await chmod(root, 0o700);
    const save = async () => {
        await writeFile(join(root, "runtime-manifest.json"), JSON.stringify(source.manifest), {
            mode: 0o644,
        });
        await chmod(join(root, "runtime-manifest.json"), 0o644);
    };
    try {
        for (const path of source.manifest.directories) {
            await mkdir(join(root, path), { recursive: true });
            await chmod(join(root, path), 0o755);
        }
        for (const file of source.manifest.files) {
            await writeFile(join(root, file.path), source.data.get(file.path)!);
            await chmod(join(root, file.path), file.mode);
        }
        for (const item of source.manifest.links) await symlink(item.target, join(root, item.path));
        await save();
        await run({ ...source, root, save });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}

/**
 * 错误断言检查正式异常类型和稳定分类，避免仅匹配随意字符串让错误实现偶然通过；测试既不依赖源码文本也不注入文件系统回调
 * ，真实 I/O 拒绝必须由公开入口产生。
 */
function code(expected: string) {
    return (error: unknown) => error instanceof MacRuntimeManifestError && error.code === expected;
}
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
const parsed = (value: ReturnType<typeof model>) => parse(bytes(value.manifest), value.expected);

/**
 * 两个架构必须由明确目标驱动而不能读取 Linux 宿主架构代替，公开结果只保留不可调用的静态事实；原始清单字节摘要由测试再
 * 次独立计算，避免实现对序列化对象计算错误摘要。
 */
for (const arch of ["x64", "arm64"] as const) {
    test(`parser accepts explicit darwin ${arch} synthetic inventory`, () =>
        assert.equal(parsed(model(arch)).arch, arch));
    test(`physical synthetic darwin ${arch} inventory succeeds on POSIX host`, async () =>
        tree(async ({ root, manifest, expected }) => {
            const result = await verify(root, expected);
            assert.equal(result.kind, "MAC_RUNTIME_STATIC_INVENTORY");
            assert.equal(result.root, root);
            assert.equal(result.arch, arch);
            assert.equal(result.regularFileCount, manifest.files.length);
            assert.equal(result.directoryCount, manifest.directories.length);
            assert.equal(result.linkCount, 0);
            assert.equal(
                result.totalFileBytes,
                manifest.files.reduce((n, item) => n + item.sizeBytes, 0),
            );
            assert.equal(
                result.manifestSha256,
                createHash("sha256")
                    .update(await readFile(join(root, "runtime-manifest.json")))
                    .digest("hex"),
            );
            assert.deepEqual(
                Object.keys(result).sort(),
                [
                    "kind",
                    "root",
                    "platform",
                    "arch",
                    "manifestSha256",
                    "manifest",
                    "regularFileCount",
                    "directoryCount",
                    "linkCount",
                    "totalFileBytes",
                ].sort(),
            );
            assert.ok(
                Object.isFrozen(result) &&
                    Object.isFrozen(result.manifest.files[0]) &&
                    Object.isFrozen(result.manifest.browser),
            );
        }, model(arch)));
}

/**
 * 输入变异逐项保持其它合同合法，只破坏命名行为对应的不变量；这些用例防止解析器容忍旧版本、未知字段、数组伪对象或依赖
 * JavaScript 隐式转换接受错误类型与非规范版本。
 */
const invalid: [string, (m: any) => void, string?][] = [
    ["schema1", (m) => (m.schemaVersion = 1)],
    ["platform", (m) => (m.platform = "linux")],
    ["arch", (m) => (m.arch = "arm64")],
    ["unknown top field", (m) => (m.ready = true)],
    ["unknown browser field", (m) => (m.browser.extra = 1)],
    ["unknown file field", (m) => (m.files[0].extra = 1)],
    ["array browser", (m) => (m.browser = [])],
    ["null file", (m) => (m.files[0] = null)],
    ["directory object", (m) => (m.directories[0] = {})],
    ["product newline", (m) => (m.productVersion = "1.0.0\n")],
    ["engine suffix", (m) => (m.engineVersion = "1.0.0+build")],
    ["long version", (m) => (m.productVersion = "1.0.0-" + "a".repeat(123))],
    ["node major only", (m) => (m.nodeVersion = "24")],
    ["electron node", (m) => (m.nodeVersion = "25.0.0")],
    ["browser version", (m) => (m.browser.version = "1.0")],
    ["browser revision", (m) => (m.browser.revision = 1254)],
    ["hash", (m) => (m.files[0].sha256 = "A".repeat(64))],
    ["size negative", (m) => (m.files[0].sizeBytes = -1)],
    ["size fractional", (m) => (m.files[0].sizeBytes = 1.2)],
    ["size unsafe", (m) => (m.files[0].sizeBytes = Number.MAX_SAFE_INTEGER + 1), "MAC_MANIFEST_LIMIT"],
    ["special mode", (m) => (m.files[0].mode = 0o4755)],
    ["writable mode", (m) => (m.files[0].mode = 0o777)],
    ["string mode", (m) => (m.files[0].mode = "755")],
    ["nonexecutable role", (m) => (m.files[0].mode = 0o644)],
    ["missing member", (m) => m.files.shift()],
    ["missing direct parent", (m) => m.directories.splice(m.directories.indexOf("entry"), 1)],
    ["duplicate path", (m) => m.files.push(m.files[0]), "MAC_MANIFEST_COLLISION"],
    ["cross set", (m) => m.directories.push(m.files[0].path), "MAC_MANIFEST_COLLISION"],
    ["manifest collision", (m) => m.directories.push("RUNTIME-MANIFEST.JSON"), "MAC_MANIFEST_COLLISION"],
    ["implicit parent case", (m) => m.directories.push("A", "a/y"), "MAC_MANIFEST_COLLISION"],
];
for (const [name, mutate, error = "MAC_MANIFEST_INVALID"] of invalid)
    test(`parser refuses ${name}`, () => {
        const m = model();
        mutate(m.manifest);
        assert.throws(() => parsed(m), code(error));
    });

/**
 * 路径策略刻意只接受保守 ASCII 子集，中文仅属于宿主根路径；即便 Unicode 已经规范化也拒绝，避免用 JavaScript 小写规则假
 * 装实现 APFS 全 Unicode 碰撞判断或静默改变原始证据。
 */
for (const path of [
    "",
    "/abs",
    "a\\b",
    "a:b",
    "a\u0000b",
    "a//b",
    "a/./b",
    "a/../b",
    "a/",
    "a.",
    "a ",
    "x.AsAr/y",
    "CON",
    "aux.txt",
    "LPT9.dat",
    "a<",
    "a>",
    'a"',
    "a|",
    "a?",
    "a*",
    "中文",
    "café",
    "cafe\u0301",
])
    test(`parser refuses nonportable path ${JSON.stringify(path)}`, () => {
        const m = model();
        m.manifest.directories.push(path);
        assert.throws(() => parsed(m), code("MAC_MANIFEST_PATH"));
    });

/**
 * 预算测试以小声明触发文件及总量限制，不创建巨大真实文件；条目、路径、层级与清单字节各自覆盖上限和下一值，保证实现不能
 * 等到深递归、大分配或正文读取后才执行拒绝。
 */
test("fixed limits are immutable and exact", () => {
    assert.ok(Object.isFrozen(limits));
    assert.deepEqual(limits, {
        manifestBytes: 4194304,
        totalEntries: 20000,
        links: 256,
        frameworkRoots: 32,
        pathBytes: 1024,
        componentBytes: 255,
        depth: 64,
        linkHops: 32,
        fileBytes: 2147483648,
        totalFileBytes: 17179869184,
    });
});
test("parser checks strict UTF8 and sanitized JSON errors", () => {
    const m = model();
    for (const input of [Buffer.from([0xff]), Buffer.from('{"secret":"never-echo-this",'), bytes([]), bytes(null)])
        assert.throws(
            () => parse(input, m.expected),
            (error: any) =>
                error instanceof MacRuntimeManifestError &&
                error.code === "MAC_MANIFEST_INVALID" &&
                !String(error.message).includes("never-echo-this") &&
                !error.cause,
        );
});
test("manifest byte limit includes whitespace and accepts exact boundary", () => {
    const m = model();
    const raw = bytes(m.manifest);
    assert.equal(
        parse(Buffer.concat([raw, Buffer.alloc(limits.manifestBytes - raw.length, 32)]), m.expected).arch,
        "x64",
    );
    assert.throws(() => parse(Buffer.alloc(limits.manifestBytes + 1, 32), m.expected), code("MAC_MANIFEST_LIMIT"));
});
test("file and total declared byte budgets", () => {
    const m = model();
    m.manifest.files[0] = { ...m.manifest.files[0]!, sizeBytes: limits.fileBytes };
    parsed(m);
    m.manifest.files[0] = { ...m.manifest.files[0]!, sizeBytes: limits.fileBytes + 1 };
    assert.throws(() => parsed(m), code("MAC_MANIFEST_LIMIT"));
    for (let i = 0; i < 8; i++) m.manifest.files[i] = { ...m.manifest.files[i]!, sizeBytes: limits.fileBytes };
    assert.throws(() => parsed(m), code("MAC_MANIFEST_LIMIT"));
});
test("entry count accepts exact boundary and refuses next member", () => {
    const m = model();
    while (m.manifest.files.length + m.manifest.directories.length < limits.totalEntries)
        m.manifest.directories.push(`empty${m.manifest.directories.length}`);
    parsed(m);
    m.manifest.directories.push("last");
    assert.throws(() => parsed(m), code("MAC_MANIFEST_LIMIT"));
});
test("component, full path and depth limits", () => {
    for (const path of [
        "a".repeat(256),
        ["a".repeat(255), "b".repeat(255), "c".repeat(255), "d".repeat(255), "e"].join("/"),
        Array(65).fill("x").join("/"),
    ]) {
        const m = model();
        m.manifest.directories.push(path);
        assert.throws(() => parsed(m), code("MAC_MANIFEST_LIMIT"));
    }
    const m = model();
    addDirectory(m.manifest, Array(64).fill("x").join("/"));
    addDirectory(m.manifest, ["a".repeat(255), "b".repeat(255), "c".repeat(255), "d".repeat(254), "e"].join("/"));
    parsed(m);
});

/**
 * 描述器不能从清单字段获得授权，所有框架根必须显式位于固定 Chrome bundle 下且互不重叠；立即修改原始输入的测试在没有
 * sleep 的情况下检验首次异步边界前完成的政策快照。
 */
test("descriptor validation rejects missing, wrong architecture paths and roots", () => {
    const m = model();
    for (const layout of [
        undefined,
        {},
        { ...m.expected.layout, executablePath: "browser/other" },
        { ...m.expected.layout, frameworkRoots: ["roles/x.framework"] },
        { ...m.expected.layout, frameworkRoots: Array(33).fill("x") },
    ])
        assert.throws(
            () => parse(bytes(m.manifest), { arch: "x64", layout } as any),
            (e) => e instanceof MacRuntimeManifestError,
        );
});
test("parser returns independent deeply frozen objects", () => {
    const m = model();
    const result = parsed(m);
    m.manifest.files[0] = { ...m.manifest.files[0]!, path: "changed" };
    assert.equal(result.files[0]!.path, "roles/agent/veriq_agent");
    assert.ok(
        Object.isFrozen(result) &&
            Object.isFrozen(result.files) &&
            Object.isFrozen(result.links) &&
            Object.isFrozen(result.directories),
    );
    assert.throws(() => result.directories.push("mutated"), TypeError);
});
test("verify snapshots descriptor before first await", async () =>
    tree(async ({ root, expected }) => {
        const promise = verify(root, expected);
        (expected.layout.frameworkRoots as string[]).push("invalid");
        (expected.layout as any).bundlePath = "changed";
        assert.equal(
            (await promise).manifest.browser.bundlePath,
            "browser/chrome-mac-x64/Google Chrome for Testing.app",
        );
    }));
test("raw whitespace changes manifest digest without changing semantic inventory", async () =>
    tree(async ({ root, expected }) => {
        const a = await verify(root, expected);
        await writeFile(join(root, "runtime-manifest.json"), JSON.stringify(a.manifest, null, 2));
        const b = await verify(root, expected);
        assert.deepEqual(a.manifest, b.manifest);
        assert.notEqual(a.manifestSha256, b.manifestSha256);
    }));

/**
 * 物理变异发生在清单写出后且不更改期望策略，验证器必须实际读取文件系统而不能仅校验 JSON；额外空目录、签名资源和嵌套同
 * 名清单都属于完整库存，不存在 basename 级别的宽泛豁免。
 */
const physical: [string, (root: string) => Promise<unknown>, string][] = [
    [
        "hash",
        (r) =>
            writeFile(
                join(r, "entry/agent.js"),
                Buffer.alloc(Buffer.byteLength("synthetic inventory bytes: entry/agent.js"), 120),
            ),
        "MAC_INVENTORY_HASH",
    ],
    ["size", (r) => writeFile(join(r, "entry/agent.js"), "changed"), "MAC_INVENTORY_HASH"],
    ["mode", (r) => chmod(join(r, "entry/agent.js"), 0o444), "MAC_INVENTORY_MODE"],
    ["suid", (r) => chmod(join(r, "entry/agent.js"), 0o4644), "MAC_INVENTORY_MODE"],
    ["directory mode", (r) => chmod(join(r, "entry"), 0o777), "MAC_INVENTORY_MODE"],
    ["missing file", (r) => rm(join(r, "entry/agent.js")), "MAC_INVENTORY_MISSING"],
    ["extra file", (r) => writeFile(join(r, "extra"), "extra"), "MAC_INVENTORY_UNLISTED"],
    ["extra empty directory", (r) => mkdir(join(r, "empty")), "MAC_INVENTORY_UNLISTED"],
    ["extra link", (r) => symlink("entry", join(r, "alias")), "MAC_INVENTORY_UNLISTED"],
    [
        "hardlink",
        async (r) => {
            await rm(join(r, "entry/agent.js"));
            await link(join(r, "entry/cli.js"), join(r, "entry/agent.js"));
        },
        "MAC_INVENTORY_HARDLINK",
    ],
    [
        "file replaced by directory",
        async (r) => {
            await rm(join(r, "entry/agent.js"));
            await mkdir(join(r, "entry/agent.js"));
        },
        "MAC_INVENTORY_TYPE",
    ],
    [
        "nested manifest unlisted",
        (r) => writeFile(join(r, "entry/runtime-manifest.json"), "{}"),
        "MAC_INVENTORY_UNLISTED",
    ],
    [
        "CodeResources unlisted",
        async (r) => {
            await mkdir(join(r, "_CodeSignature"));
            await writeFile(join(r, "_CodeSignature/CodeResources"), "seal");
        },
        "MAC_INVENTORY_UNLISTED",
    ],
    ["fifo", (r) => Promise.resolve(execFileSync("mkfifo", [join(r, "pipe")])), "MAC_INVENTORY_TYPE"],
    ["root mode", (r) => chmod(r, 0o777), "MAC_INVENTORY_MODE"],
    ["manifest mode", (r) => chmod(join(r, "runtime-manifest.json"), 0o666), "MAC_INVENTORY_MODE"],
    ["manifest hardlink", (r) => link(join(r, "runtime-manifest.json"), join(r, "other")), "MAC_INVENTORY_HARDLINK"],
    [
        "manifest link",
        async (r) => {
            const raw = await readFile(join(r, "runtime-manifest.json"));
            await writeFile(join(r, "other"), raw);
            await rm(join(r, "runtime-manifest.json"));
            await symlink("other", join(r, "runtime-manifest.json"));
        },
        "MAC_INVENTORY_TYPE",
    ],
    [
        "manifest oversized",
        (r) => writeFile(join(r, "runtime-manifest.json"), Buffer.alloc(limits.manifestBytes + 1, 32)),
        "MAC_MANIFEST_LIMIT",
    ],
];
for (const [name, mutate, error] of physical)
    test(`physical tree refuses ${name}`, async () =>
        tree(async ({ root, expected }) => {
            await mutate(root);
            await assert.rejects(verify(root, expected), code(error));
        }));
test("root and ancestor symlinks and ASAR roots are refused", async () =>
    tree(async ({ root, expected }) => {
        const parent = await mkdtemp(join(tmpdir(), "veriq-root-"));
        try {
            await symlink(root, join(parent, "alias"));
            await assert.rejects(verify(join(parent, "alias"), expected), code("MAC_INVENTORY_ROOT"));
            await symlink(dirname(root), join(parent, "ancestor"));
            await assert.rejects(
                verify(join(parent, "ancestor", root.split("/").at(-1)!), expected),
                code("MAC_INVENTORY_ROOT"),
            );
            await mkdir(join(parent, "Runtime.AsAr"));
            await assert.rejects(verify(join(parent, "Runtime.AsAr"), expected), code("MAC_INVENTORY_ROOT"));
            await assert.rejects(verify("relative", expected), code("MAC_INVENTORY_ROOT"));
        } finally {
            await rm(parent, { recursive: true, force: true });
        }
    }));
test("listed nested manifest and signature resources are hashed with multiMB file", async () => {
    const m = model();
    addFile(m.manifest, m.data, "entry/runtime-manifest.json");
    addFile(m.manifest, m.data, "_CodeSignature/CodeResources");
    addFile(m.manifest, m.data, "large.dat", 0o444, Buffer.alloc(3 * 1024 * 1024, 37));
    await tree(async ({ root, expected }) => {
        assert.ok((await verify(root, expected)).totalFileBytes > 3 * 1024 * 1024);
        await writeFile(join(root, "_CodeSignature/CodeResources"), "changed");
        await assert.rejects(verify(root, expected), code("MAC_INVENTORY_HASH"));
    }, m);
});

/**
 * 合成 framework 保留版本目录与目录别名的真实关系，允许链接最终到普通目录或文件但不允许别名产生虚构库存；所有 raw
 * target 都单独记录，用来识别先 normalize 后比较造成的授权扩大。
 */
function framework() {
    const m = model("x64", 1);
    const f = m.expected.layout.frameworkRoots[0]!;
    addFile(m.manifest, m.data, `${f}/Versions/A/Resources/data`);
    withLinks(m, [
        { path: `${f}/Versions/Current`, target: "A" },
        { path: `${f}/Resources`, target: "Versions/Current/Resources" },
        { path: `${f}/alias`, target: "Resources/data" },
    ]);
    return { ...m, f };
}
/**
 * 链接变异保持真实文件系统与清单的描述一致，仅有意破坏待检验的解析边界；这使跨根、越界后返回和目录图循环必须靠有限组件
 * 解析拒绝，不能碰巧被摘要或缺失文件错误遮蔽。
 */
function withLinks(m: ReturnType<typeof model>, links: RuntimeLinkV2[]) {
    m.manifest.links = links;
    m.expected.layout = { ...m.expected.layout, allowedLinks: links.map((v) => ({ ...v })) };
    for (const v of links) addDirectory(m.manifest, dirname(v.path));
    return m;
}
test("framework directory Current, Resources and file alias succeed", async () => {
    const m = framework();
    parsed(m);
    await tree(async ({ root, expected }) => assert.equal((await verify(root, expected)).linkCount, 3), m);
});
test("allowedLinks is exact, order independent, and not read from manifest", () => {
    const m = framework();
    m.manifest.links.reverse();
    parsed(m);
    (m.expected.layout.allowedLinks as RuntimeLinkV2[]).pop();
    assert.throws(() => parsed(m), code("MAC_MANIFEST_LAYOUT"));
});
for (const target of ["/outside", "a\\b", "a:b", "a//b", "a/", "", "中文", "x.AsAr", "CON", "x\u0001"])
    test(`link target rejects ${JSON.stringify(target)}`, () => {
        const m = framework();
        withLinks(m, [{ path: `${m.f}/alias`, target }]);
        assert.throws(() => parsed(m), code("MAC_LINK_TARGET"));
    });
test("links outside framework and duplicate roots are forbidden", () => {
    const m = framework();
    withLinks(m, [{ path: "roles/alias", target: "agent/veriq_agent" }]);
    assert.throws(() => parsed(m), code("MAC_LINK_FORBIDDEN"));
    const n = framework();
    n.expected.layout = { ...n.expected.layout, frameworkRoots: [n.f, n.f] };
    assert.throws(() => parsed(n), code("MAC_MANIFEST_LAYOUT"));
});
test("raw readlink target must match without normalization", async () => {
    const m = framework();
    await tree(async ({ root, expected }) => {
        await rm(join(root, m.f, "Versions/Current"));
        await symlink("./A", join(root, m.f, "Versions/Current"));
        await assert.rejects(verify(root, expected), code("MAC_LINK_TARGET"));
    }, m);
});
for (const [name, targets, error] of [
    ["dangling", ["missing"], "MAC_LINK_TARGET"],
    ["self cycle", ["a"], "MAC_LINK_CYCLE"],
    ["mutual cycle", ["b", "a"], "MAC_LINK_CYCLE"],
    ["escape then return", ["../Synthetic0.framework/Versions/A"], "MAC_LINK_TARGET"],
    ["cross framework", ["../Synthetic1.framework"], "MAC_LINK_TARGET"],
    ["nondirectory middle", ["Versions/A/Resources/data/child"], "MAC_LINK_TARGET"],
    ["directory ancestor cycle", ["."], "MAC_LINK_CYCLE"],
] as const)
    test(`link resolution refuses ${name}`, async () => {
        const m = framework();
        if (name === "cross framework") {
            const second = m.f.replace("Synthetic0", "Synthetic1");
            addDirectory(m.manifest, second);
            m.expected.layout = { ...m.expected.layout, frameworkRoots: [m.f, second] };
        }
        withLinks(
            m,
            targets.map((target, i) => ({ path: `${m.f}/${String.fromCharCode(97 + i)}`, target })),
        );
        await tree(async ({ root, expected }) => assert.rejects(verify(root, expected), code(error)), m);
    });
test("directory aliases cannot create a mutual virtual tree cycle", async () => {
    const m = framework();
    addDirectory(m.manifest, `${m.f}/X`);
    addDirectory(m.manifest, `${m.f}/Y`);
    withLinks(m, [
        { path: `${m.f}/X/toY`, target: "../Y" },
        { path: `${m.f}/Y/toX`, target: "../X" },
    ]);
    await tree(async ({ root, expected }) => assert.rejects(verify(root, expected), code("MAC_LINK_CYCLE")), m);
});
for (const count of [32, 33])
    test(`link chain ${count} hops`, async () => {
        const m = framework();
        withLinks(
            m,
            Array.from({ length: count }, (_, i) => ({
                path: `${m.f}/l${i}`,
                target: i === count - 1 ? "Versions/A/Resources/data" : `l${i + 1}`,
            })),
        );
        await tree(async ({ root, expected }) => {
            if (count === 32) assert.equal((await verify(root, expected)).linkCount, 32);
            else await assert.rejects(verify(root, expected), code("MAC_LINK_LIMIT"));
        }, m);
    });
test("link budget permits 256 entries and refuses 257", () => {
    const m = framework();
    withLinks(
        m,
        Array.from({ length: 256 }, (_, i) => ({
            path: `${m.f}/link${i}`,
            target: "Versions/A/Resources/data",
        })),
    );
    parsed(m);
    m.manifest.links.push({ path: `${m.f}/excess`, target: "Versions/A" });
    assert.throws(() => parsed(m), code("MAC_MANIFEST_LIMIT"));
});
test("manifest cannot invent physical files beneath directory aliases", () => {
    const m = framework();
    addFile(m.manifest, m.data, `${m.f}/Resources/invented`);
    assert.throws(
        () => parsed(m),
        (e) => e instanceof MacRuntimeManifestError,
    );
});

/**
 * 最小库存逐一移除每个必需普通成员，防止检查只覆盖角色入口却遗漏执行闭包、原生插件或独立保险库辅助程序；这些名字仍只是
 * 静态合同，不通过文件名推断源码测试二进制是否属于正式发行。
 */
for (const file of model().manifest.files)
    test(`required direct member ${file.path}`, () => {
        const m = model();
        m.manifest.files = m.manifest.files.filter((v) => v.path !== file.path);
        assert.throws(() => parsed(m), code("MAC_MANIFEST_INVALID"));
    });
test("exact total byte boundary does not require large fixture allocation", () => {
    const m = model();
    m.manifest.files = m.manifest.files.map((file, i) => ({
        ...file,
        sizeBytes: i < 8 ? limits.fileBytes : 0,
    }));
    parsed(m);
    m.manifest.files[8] = { ...m.manifest.files[8]!, sizeBytes: 1 };
    assert.throws(() => parsed(m), code("MAC_MANIFEST_LIMIT"));
});
test("all permitted file modes preserve exact metadata", async () => {
    const m = model();
    for (const [i, mode] of [0o444, 0o644, 0o555, 0o755].entries()) addFile(m.manifest, m.data, `mode${i}`, mode);
    await tree(async ({ root, expected }) => {
        await chmod(root, 0o555);
        await chmod(join(root, "entry"), 0o555);
        try {
            await verify(root, expected);
        } finally {
            await chmod(root, 0o700);
            await chmod(join(root, "entry"), 0o755);
        }
        await chmod(root, 0o755);
        await verify(root, expected);
    }, m);
});
test("missing directory and root manifest fail closed", async () =>
    tree(async ({ root, expected }) => {
        await rm(join(root, "entry"), { recursive: true });
        await assert.rejects(verify(root, expected), code("MAC_INVENTORY_MISSING"));
        await rm(join(root, "runtime-manifest.json"));
        await assert.rejects(verify(root, expected), code("MAC_INVENTORY_MISSING"));
        await assert.rejects(verify(join(root, "absent"), expected), code("MAC_INVENTORY_ROOT"));
    }));
test("physical member Unicode and ASAR are refused", async () =>
    tree(async ({ root, expected }) => {
        for (const path of ["中文", "Resources.AsAr"]) {
            await mkdir(join(root, path));
            await assert.rejects(verify(root, expected), code("MAC_MANIFEST_PATH"));
            await rm(join(root, path), { recursive: true });
        }
    }));
test("descriptor nested link entries are snapshotted synchronously", async () => {
    const m = framework();
    await tree(async ({ root, expected }) => {
        const promise = verify(root, expected);
        (expected.layout.allowedLinks[0] as { target: string }).target = "outside";
        (expected.layout.allowedLinks as RuntimeLinkV2[]).splice(1);
        assert.equal((await promise).linkCount, 3);
    }, m);
});
test("link and layout unknown fields are rejected", () => {
    const m = framework();
    (m.manifest.links[0] as any).trusted = true;
    assert.throws(() => parsed(m), code("MAC_MANIFEST_INVALID"));
    const n = model();
    (n.expected.layout as any).ready = true;
    assert.throws(() => parsed(n), code("MAC_MANIFEST_LAYOUT"));
});
test("framework root cannot be an alias", () => {
    const m = framework();
    m.manifest.directories = m.manifest.directories.filter((path) => path !== m.f);
    withLinks(m, [{ path: m.f, target: "Synthetic1.framework" }]);
    assert.throws(
        () => parsed(m),
        (error) => error instanceof MacRuntimeManifestError,
    );
});
test("case collisions include implicit physical parents across all sets", () => {
    const m = model();
    addFile(m.manifest, m.data, "A/x");
    m.manifest.directories.push("a");
    assert.throws(() => parsed(m), code("MAC_MANIFEST_COLLISION"));
});
test("portable subset rejects device basenames with spaces before extension", () => {
    const m = model();
    m.manifest.directories.push("CON .txt");
    assert.throws(() => parsed(m), code("MAC_MANIFEST_PATH"));
});

/**
 * 错误分类是公开稳定合同的一部分，运行时也不能让调用者意外覆写后误判失败原因；公开诊断只保存受控 errno，而不是把系统路
 * 径、JSON 原文或任意输入内容塞进消息与 cause。
 */
test("error code is read-only at runtime", () => {
    const error = new MacRuntimeManifestError("MAC_MANIFEST_INVALID");
    assert.throws(() => ((error as { code: string }).code = "changed"), TypeError);
    assert.equal(error.code, "MAC_MANIFEST_INVALID");
});
for (const path of ["CONIN$", "conout$.log"])
    test(`portable subset rejects console device ${path}`, () => {
        const m = model();
        m.manifest.directories.push(path);
        assert.throws(() => parsed(m), code("MAC_MANIFEST_PATH"));
    });
test("expected missing I/O has only sanitized errno cause", async () =>
    tree(async ({ root, expected }) => {
        await rm(join(root, "runtime-manifest.json"));
        await assert.rejects(
            verify(root, expected),
            (error: any) =>
                error instanceof MacRuntimeManifestError &&
                error.code === "MAC_INVENTORY_MISSING" &&
                JSON.stringify(error.cause) === '{"code":"ENOENT"}' &&
                !error.message.includes(root),
        );
    }));

/**
 * 竞争检查使用真实句柄和真实元数据，只在已完成的第二次 fstat 后安排实际 chmod 来形成确定性变化；测试不伪造 stat 或字节
 * ，也不给产品入口增加回调，因而无需 sleep 或不稳定的大文件写入竞速。
 */
test("observed file change between final fstat and path lstat has dedicated code", async (t) =>
    tree(async ({ root, expected }) => {
        const target = join(root, "entry/agent.js");
        const originalOpen = fs.open;
        t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
            const handle = await originalOpen(...args);
            if (args[0] === target) {
                const originalStat = handle.stat.bind(handle);
                let calls = 0;
                t.mock.method(handle, "stat", async (options: any) => {
                    const info = await originalStat(options);
                    if (++calls === 2) await chmod(target, 0o444);
                    return info;
                });
            }
            return handle;
        });
        syncBuiltinESMExports();
        try {
            await assert.rejects(verify(root, expected), code("MAC_INVENTORY_CHANGED"));
        } finally {
            t.mock.restoreAll();
            syncBuiltinESMExports();
        }
    }));

/**
 * 环检测必须识别每次增加未消费后缀的递归链接，而不能只等完全相同的展开状态重复；合法路径仍可在一次展开结束后再次使用同
 * 一个目录别名，因此不能粗暴地把所有重复路径都当作环。
 */
for (const targets of [["a/child"], ["b/child", "a/child"]])
    test(`recursive symlink suffix growth is a cycle with ${targets.length} links`, async () => {
        const m = framework();
        withLinks(
            m,
            targets.map((target, i) => ({ path: `${m.f}/${String.fromCharCode(97 + i)}`, target })),
        );
        await tree(async ({ root, expected }) => assert.rejects(verify(root, expected), code("MAC_LINK_CYCLE")), m);
    });
test("finite repeated use of directory alias in one target succeeds", async () => {
    const m = framework();
    const links = [
        ...m.manifest.links,
        { path: `${m.f}/repeated`, target: "Versions/Current/../Current/Resources/data" },
    ];
    withLinks(m, links);
    await tree(async ({ root, expected }) => assert.equal((await verify(root, expected)).linkCount, 4), m);
});
test("explicit framework count accepts 32 and refuses 33", () => {
    parsed(model("x64", 32));
    assert.throws(() => parsed(model("x64", 33)), code("MAC_MANIFEST_LIMIT"));
});

/**
 * 读取链接前已经观察到真实 symlink，若它在 lstat 与 readlink 之间消失就属于变化而不是初始缺失；受控交错仍调用真实
 * readlink 并产生真实 ENOENT，不伪造返回值，也不使用计时器碰运气。
 */
test("link removed after observed lstat reports changed", async (t) => {
    const m = framework();
    await tree(async ({ root, expected }) => {
        const target = join(root, m.f, "alias");
        const originalReadlink = fs.readlink;
        t.mock.method(fs, "readlink", async (...args: Parameters<typeof fs.readlink>) => {
            if (args[0] === target) await rm(target);
            return originalReadlink(...args);
        });
        syncBuiltinESMExports();
        try {
            await assert.rejects(verify(root, expected), code("MAC_INVENTORY_CHANGED"));
        } finally {
            t.mock.restoreAll();
            syncBuiltinESMExports();
        }
    }, m);
});

/**
 * 清单本身的精确字节上限也用真实文件读取验收，额外空白仍属于摘要输入且只读权限必须允许；合成空目录明确列入 directories
 * 后可通过，避免把拒绝未知目录误实现为拒绝所有空目录。
 */
test("physical exact 4MiB readonly manifest and listed empty directory succeed", async () => {
    const m = model();
    addDirectory(m.manifest, "empty");
    await tree(async ({ root, expected, manifest }) => {
        const raw = bytes(manifest);
        await writeFile(
            join(root, "runtime-manifest.json"),
            Buffer.concat([raw, Buffer.alloc(limits.manifestBytes - raw.length, 32)]),
        );
        await chmod(join(root, "runtime-manifest.json"), 0o444);
        assert.equal((await verify(root, expected)).directoryCount, manifest.directories.length);
    }, m);
});
test("product version accepts exact 128 character boundary", () => {
    const m = model();
    m.manifest.productVersion = "1.0.0-" + "a".repeat(122);
    assert.equal(parsed(m).productVersion.length, 128);
});
