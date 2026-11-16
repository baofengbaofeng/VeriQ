<a id="veriq-mac-runtime-v2-静态库存"></a>

# Runtime Manifest V2

本合同提供普通 POSIX 宿主上可运行的静态验证器，目标明确为 Darwin x64 或 arm64。Linux 合成树测试验证真实 hash、权限与链接语义，测试字节不是 Mac 二进制。本模块未连接旧 schema1 加载器、执行路径、原生能力或产品入口，不证明已安装、签名、Mach-O 架构、实际组件版本或完整 MVP 就绪。F01–F14、Mac15+ 双架构、Windows11 和 Ubuntu24 的完整产品范围保持不变。

实现入口为 `apps/runtime/src/distribution-manifest-v2.ts`：

```ts
parseMacRuntimeManifestV2(
    bytes: Uint8Array,
    expected: { arch: MacRuntimeArch; layout: MacChromeLayout },
): Readonly<MacRuntimeManifestV2>;

verifyMacRuntimeManifestV2(
    root: string,
    expected: { arch: MacRuntimeArch; layout: MacChromeLayout },
): Promise<MacRuntimeStaticInventory>;
```

`parse` 不访问操作系统。`verify` 固定读取根下 `runtime-manifest.json`，完整枚举物理树；调用者不能指定另一个清单路径、提供任意 fs/exec 回调或放宽预算。目标不由宿主 platform/arch 推测。可信布局在首次 await 前验证、独立复制并冻结，随后修改调用者的数组或链接对象不会改变正在执行的政策。清单和结果均重新构造并深冻结。

## 公共数据合同

```ts
type MacRuntimeArch = "x64" | "arm64";
type RuntimeFileV2 = Readonly<{
    path: string;
    sizeBytes: number;
    sha256: string;
    mode: number;
}>;
type RuntimeLinkV2 = Readonly<{ path: string; target: string }>;
type MacChromeLayout = Readonly<{
    bundlePath: string;
    executablePath: string;
    frameworkRoots: readonly string[];
    allowedLinks: readonly RuntimeLinkV2[];
}>;

type MacRuntimeManifestV2 = {
    schemaVersion: 2;
    platform: "darwin";
    arch: MacRuntimeArch;
    productVersion: string;
    nodeVersion: string;
    engineVersion: string;
    browser: {
        version: "158.0.8127.18";
        revision: "1254";
        bundlePath: string;
        executablePath: string;
    };
    directories: string[];
    files: RuntimeFileV2[];
    links: RuntimeLinkV2[];
};
```

JSON 必须为严格 UTF-8、精确字段集合和类型；schema1、未知字段、数组替代对象、非安全整数均拒绝。SHA256 必须为 64 位小写十六进制。productVersion/engineVersion 长度至多 128，格式为三段数字，可带 `-[A-Za-z0-9.-]+`；尾随换行不合法。nodeVersion 使用独立稳定 Node24 的具体三段版本规则，拒绝前导零、预发布及 Electron 内嵌 Node 替代。

directories 列出全部物理子目录，包括空目录而不包括根。files、links、directories 完全互斥；每个非根父目录都必须在 directories 中。不得在符号链接 alias 下虚构目录或文件。只有根清单自排除；嵌套 `runtime-manifest.json`、依赖/chunks 和 `_CodeSignature/CodeResources` 必须完整登记并 hash。

mode 使用 JSON 十进制整数：292/420/365/493 分别表示 0444/0644/0555/0755。核对实际 `mode & 07777`，不自动 chmod；角色、Chrome 主入口和保险库辅助进程必须为 0555/0755。清单自身只允许 0444/0644，物理子目录只允许 0555/0755，根允许 0700/0555/0755。普通文件包含清单均要求 nlink=1，拒绝重复 dev+ino；符号链接不比较声明权限。宿主必须真实提供可证明的 POSIX 元数据及安全打开语义，无法提供时失败，不按声明模拟成功；这不改变产品 Windows 支持范围。

## 固定布局与有限链接

bundlePath 固定为 `browser/chrome-mac-${arch}/Google Chrome for Testing.app`，executablePath 固定为该 bundle 的 `Contents/MacOS/Google Chrome for Testing`。Chrome 固定 158.0.8127.18 / revision 1254，与 Playwright1.65.0 配套；不能替换成系统 Chrome、headless-shell、Electron Chromium 或另一架构。

layout 是清单之外的可信输入，frameworkRoots 和 allowedLinks 即使为空也必须显式传入。每个框架根必须为 bundle 下 `Contents/Frameworks/<单组件>.framework` 的真实目录，不能自身为链接；根不可重复或重叠。manifest.links 与 allowedLinks 的 path/原始 target 集合精确相等，顺序无关。额外的“仍在框架内”链接不会自动获得授权。Electron 外层 Framework 不在本合同中。

以下仅是演示调用的**合成布局**，SyntheticInventory.framework 不是实际 Chrome 归档的默认名称或正式发布描述信息：

```ts
const bundlePath = "browser/chrome-mac-arm64/Google Chrome for Testing.app";
const framework = `${bundlePath}/Contents/Frameworks/SyntheticInventory.framework`;
const layout: MacChromeLayout = {
    bundlePath,
    executablePath: `${bundlePath}/Contents/MacOS/Google Chrome for Testing`,
    frameworkRoots: [framework],
    allowedLinks: [
        { path: `${framework}/Versions/Current`, target: "A" },
        { path: `${framework}/Resources`, target: "Versions/Current/Resources" },
    ],
};
const inventory = await verifyMacRuntimeManifestV2(stagingRoot, {
    arch: "arm64",
    layout,
});
```

该例仍要求真实树及清单完整列出框架、Versions/A/Resources、全部父目录与文件，以及 Runtime 最小成员。D3.2 生产器必须从真实目标归档枚举描述信息、记录来源并复审，不能发布合成测试布局；真实资产不满足当前合同必须阻断。

原始 target 为非空相对 POSIX 路径，允许有限 `.`/`..`，不预先规范化。实际 readlink 原值须精确匹配。解析每一步都留在同一显式框架根内，越界后返回也拒绝；中间节点必须为目录。拒绝悬空、自环、互环、超过 32 跳及跨框架链接。终点必须是已核普通文件或完整枚举的物理目录；目录 alias 还参加物理目录边与 alias 边联合图的无环检查，避免无限虚拟树。

所有成员及描述信息 path 使用 `/` 的相对路径：拒绝空、绝对、反斜线、冒号、控制符、空组件、`.`/`..`、尾点/空格、大小写无关 `.asar` 结尾组件、Windows 设备名及 `< > " | ? *`。组件只接受可打印 ASCII 并检查 NFC；非 ASCII 即使 composed 也拒绝，不静默改写。碰撞覆盖每个累计父组件及固定清单，`A/x` 与 `a/y` 冲突。宿主绝对 root 可含中文和空格，逐级拒绝自身或祖先符号链接与 ASAR。

## 固定预算与最小成员

`MAC_RUNTIME_MANIFEST_V2_LIMITS` 为冻结对象，不提供放宽参数：

| 字段                       | 上限                              |
| -------------------------- | --------------------------------- |
| manifestBytes              | 4 MiB                             |
| totalEntries               | 20,000（文件+目录+链接） |
| links / frameworkRoots     | 256 / 32                          |
| pathBytes / componentBytes | 1,024 / 255                       |
| depth / linkHops           | 64 / 32                           |
| fileBytes / totalFileBytes | 2 GiB / 16 GiB                    |

限制在声明解析、枚举及实际流读取时执行。普通文件用固定小块句柄流 hash；清单先核类型、链接数和大小再限量读取。读前后 fstat 和路径 lstat、末尾成员复查发现观察到的身份、大小、时间或权限变化即失败，不重试到成功。

最小 files 必须直接包含：

- `roles/agent/veriq_agent`、`roles/cli/veriq_cli`、`roles/runner/veriq_runner` 和固定 Chrome 主入口。
- `entry/agent.js`、`entry/cli.js`、`npm/bin/npm-cli.js`、`node_modules/tsx/dist/loader.mjs`、`engines/${engineVersion}/inventory.json`。
- execution 下 `worker.mjs`、`provider.mjs`、`compile-entry.mjs`、`archive.mjs`、`controlled-command.mjs`、`controlled-child.mjs`、`controlled-child-protocol.mjs`、`controlled-child-preload.mjs`。
- `native/veriq_private_files.node` 和 `native/vault/veriq_agent`。

不要求 Mac guardian `native/veriq_runner`，不解读引擎库存授权，不 dlopen/spawn 成员。完整生产依赖可继续列入 files；生产构建排除 test/fault/controller 的白名单及来源证据属于 D3.2，文件名检查不能识别伪装二进制。

## 结果与失败语义

成功结果字段固定为 `kind: "MAC_RUNTIME_STATIC_INVENTORY"`、root、`platform: "darwin"`、arch、manifestSha256、manifest、regularFileCount、directoryCount、linkCount、totalFileBytes。计数不含根清单。manifestSha256 对原始字节计算，包括空白；相同语义不同空白产生不同摘要。摘要不证明发布者真实性，结果不含可调用能力或已授权执行绝对路径。

导出 `MacRuntimeManifestError` 和只读 code；公开消息固定英文，不回显文件内容。JSON 解析异常不挂载原始 cause；I/O cause 只保留受控 errno 分类。固定码全集：

| 范围     | code                                                                                                                                                                                           |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 清单     | MAC_MANIFEST_INVALID、MAC_MANIFEST_LIMIT、MAC_MANIFEST_PATH、MAC_MANIFEST_COLLISION、MAC_MANIFEST_LAYOUT                                                                                       |
| 物理库存 | MAC_INVENTORY_ROOT、MAC_INVENTORY_MISSING、MAC_INVENTORY_UNLISTED、MAC_INVENTORY_TYPE、MAC_INVENTORY_HARDLINK、MAC_INVENTORY_MODE、MAC_INVENTORY_HASH、MAC_INVENTORY_CHANGED、MAC_INVENTORY_IO |
| 链接     | MAC_LINK_FORBIDDEN、MAC_LINK_TARGET、MAC_LINK_CYCLE、MAC_LINK_LIMIT                                                                                                                            |

调用者须保持输入为受控静止暂存树，冻结后续消费并在消费前复验。前后身份检查不提供原子整树快照，也不承诺纯 JavaScript 抵抗恶意父目录并发替换。D3.2 封存生产器消费此固定 schema 与可信描述信息；安装角色授权、Electron 主进程直接装载已核 Darwin 插件、独立 Keychain 辅助进程、签名与原生运行验收属于后续组件。
