# VeriQ macOS Runtime 静态输入核验

本片提供真实输入核验器与 inspect CLI。它核配方、独立 expected、原始文件字节、五棵完整输入树、构建收据、静态依赖图及引擎原库存；不生成 Runtime 候选目录，不解压归档，不执行输入程序。

## 使用

工作区已按锁安装依赖，使用 Node24 稳定版本，并具备内建 `zlib.crc32`。`tsx` 是 Runtime 的直接依赖，命令从 Runtime 工作目录运行：

```sh
cd apps/runtime
node --import tsx scripts/inspect-macos-runtime-inputs.mjs \
    --inputs /absolute/input-recipe.json \
    --expected /absolute/reviewed-expected.json \
    --input-root '/absolute/输入 根'
```

三个 flag 必填、各一次；未知、重复或缺失参数拒绝。没有环境变量或缺省目录选择。`inputRoot` 必须为真实绝对目录，祖先不得经过 symlink、点组件或 ASAR；宿主根可含中文和空格，成员使用可移植 ASCII 相对路径。CLI 的两份外层 JSON 各最多 4 MiB，通过单链接普通文件和 held-FD 身份检查读取。

成功时 stdout 只有一份完整 `InputInspection` JSON。失败时 stdout 无成功报告，stderr 只显示稳定英文 code、`phase=INPUTS`、cleanup，并以非零退出。SIGINT/SIGTERM 通过同一 AbortController 停止准入及读取，正常结束分别退出 130/143；二次信号或五秒关闭期限报告 `cleanup=INCOMPLETE`。输入文件从不删除，没有 scratch 或输出目录。

## 两个公开入口

类型与入口集中在 `apps/runtime/scripts/runtime-payload-inputs.ts`；所有 DTO 及返回数组深只读，解码对象拒绝缺失字段、未知字段、错误类型、非严格 UTF8 或非法摘要。

```ts
parseRuntimePayloadInputs(bytes: Uint8Array, expected: ExpectedPayloadInputs): Readonly<Recipe>;
verifyRuntimePayloadInputs(
    bytes: Uint8Array,
    expected: ExpectedPayloadInputs,
    options: { inputRoot: string; signal?: AbortSignal },
): Promise<Readonly<InputInspection>>;
```

两个入口都在首次 await 前复制 bytes、验证并独立复制冻结 expected；verify 还快照 inputRoot 和 signal。调用者随后原地改写输入不会改变已选政策。parse 只核配方结构与独立绑定，verify 自行 parse 后完成真实读取，结果全部深冻结。expected 必须由外层来源绑定审核独立提供，包含 recipe 原字节摘要、完整 target、commit、SourceBinding、pnpm 锁及 Chrome 布局摘要，不能从配方自举。

## 已实现核验

- 每个 Ref 实际读取并核 hash、长度、路径、单链接普通文件身份。来源 archive 只核原始文件；SourceBinding.files 指向 inputRoot 中源码相对路径副本，Build.producer/config 与 native sourceFiles 必须使用其中相同 Ref。opaque evidence 的字节通过不等于认证其语义或工具执行。
- 五个 BoundTree 根互不重叠；inventory、receipt 和其它证据位于树外。完整枚举目录、文件、有限链接，拒绝额外或遗漏成员、隐藏空目录、大小写/重复/type 冲突、hardlink、special、unsafe mode。普通内容以 64 KiB 块顺序读取，held FD 前后 fstat、路径 lstat 与收尾观察检测来源变化，变化后不重试。
- entries/execution/native/engine 禁止链接；dependencies 仅容纳 bins 中明确 sourceAlias 的逻辑链接，readlink 不解引用。包 target 保留原位置；本片不写 shim。node launcher 只接受无 shebang 或两种固定 Node shebang，native launcher 的独立 inspection 记录及 evidence 必须匹配 target hash、Darwin arch 和不高于 15.0.0 的 minimumOs。
- 工具集合恰好是基础 node/pnpm/tar/yauzl 与各 Build.toolNames 并集，固定 pnpm11.25.0、tar7.5.22、yauzl3.4.0；Node 与 target 版本一致。所有收据的 commit、来源绑定、锁、target、inventory 摘要与 kind 逐项闭合。
- 产品 native 恰好两个正式输出。addon 源码为 `apps/runtime/native/darwin/{addon.cc,private-files.h}`，显式宏恰为 `NAPI_CPP_EXCEPTIONS`、`NAPI_VERSION=9`；vault 源码为 `apps/runtime/native/vault/{darwin-vault.mm,darwin-acl.hpp}`，显式宏为空。来源还包含 Darwin binding.gyp 和两个正式 build 脚本。第三方 native bin 使用独立检查 DTO。
- 外层依赖图核真实 package.json name/version/hash、JCS 自有树摘要、完整 dependencies/optional/peer 声明覆盖、optional 决策、实例与解析文件归属、所有声明 bin 的计划及 alias/owner/target 一致性。optionalDependencies 覆盖同名 dependency，peer meta 决定 optional-peer。不同 peer 上下文保留独立实例，不解析 pnpm YAML 或执行安装。
- 所有生产实例必须从 rootBindings 沿非空 edges 可达，允许循环。根 tsx 绑定固定为 `consumer=package.json`、`specifier=tsx`，实例为 `node_modules/tsx`、4.23.15，proof.from=`$root`、resolvedFile=`node_modules/tsx/dist/loader.mjs`。只有该后续生成的根 consumer 可以暂时没有物理输入。
- TypeScript5.9.3 AST 检查字面 ES import/export/dynamic-import。入口收据与真实静态边一致，JS asset 不能隐藏导入；execution 固定八 MJS hash 绑定并核外部 imports。node: 内建采用 Node24 builtinModules；Electron/desktop 外部入口拒绝。compile-entry 固定 compiler Attempt 相对路径是既有例外；非字面动态加载不在静态穷尽承诺内。
- NodeReceipt.npmGraph 只核 schema、预算、引用、声明可达性及归档绑定；npm 根版本/packageJson 与 NodeReceipt 一致，npm-cli 有明确 `$npm` proof。没有读取归档内的 npm 正文、真实 links 或执行 Node resolve。Chrome layout 沿用 D3a DTO，只核结构、独立布局摘要及 archive 绑定，没有核到真实 Framework。
- 原引擎 inventory 复用 ApprovedEngineInventoryV1 schema，唯一目标版本 entry、JCS entry 摘要、原 inventory 摘要、完整白名单 files、版本及 dependencies.json 全部一致，强制四基本文件。原字节不改，不调用批准 loader 或晋升工具。

固定预算：JSON4 MiB、package.json1 MiB、单普通文件及每原归档2 GiB、五树合计40000成员/1024 links/16 GiB，package实例4000、edges和resolutions各20000、bins2000，外部证据累计64 MiB。需要 AST 的代码单文件16 MiB、合计64 MiB，声明在树正文读取前统一核验，逐文件解析释放。路径1024字节、组件255字节、深度64。原生 bin shebang 检查只保留256字节头部，不把普通二进制套进 JSON/AST 限额。

## 固定未完成边界

成功状态为 `BOUND_INPUTS_STATIC_VERIFIED_ARCHIVES_PENDING`，graphStatus 为 `STATIC_REFERENCES_VERIFIED`，下列 pending 总是完整返回，调用方不能清空：

```json
[
    "ARCHIVE_MEMBERS",
    "NPM_ARCHIVE_CONTENT_AND_GRAPH",
    "CHROME_PHYSICAL_LAYOUT",
    "TARGET_EXECUTION_AND_PROVENANCE",
    "FINAL_PAYLOAD_V2"
]
```

checkedEvidence 精确列出真正读过并核过的去重 Ref。压缩文件原始 hash 通过不代表成员、CRC、解压安全或 npm 内容已核。外部工具、SDK、GraphProof 与 inspection 的一致声明不能证明 Git 来源、上游签名、真实构建、MachO 内容或发布者身份。

后续 b1b 消费相同 DTO 并重新调用 verify、重新检查所有来源身份，再实现受限归档 intake、stage 与最终 D3a v2 库存；旧报告不能作为持久执行 capability。b2 负责真实双原生 Mac 来源构建、Node/MachO/Chrome、peer 解析与 relocation 等验收。此片不等于 whole T20 或完整 MVP。

纯 JavaScript 的观察不能提供原子整树快照，也不宣称抵抗恶意同 UID 父路径并发替换。调用者须保持输入静止，后续消费前重验。全仓 B05 注释覆盖门禁既有失败仍未豁免；本片通过不代表全仓质量门禁已通过。
