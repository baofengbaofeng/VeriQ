# VeriQ macOS Runtime 静态输入核验与有界归档准备

本说明覆盖真实输入核验器与 inspect CLI，以及下文独立的有界归档 prepare。inspect 核配方、独立 expected、原始文件字节、五棵完整输入树、构建收据、静态依赖图及引擎原库存；prepare 进一步安全扫描并提取原归档为私有普通文件树。inspect 与 prepare 不生成 Runtime 候选；下文 stage 组装完整开发未签名静态候选，所有工具均不执行输入程序。

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

下文有界 prepare 已消费相同 DTO 并重新调用 verify、独立检查来源身份，交付原归档 intake。下文 S stage 继续重验原字节与来源，组装完整静态候选并实测最终 D3a v2 库存；旧报告不能作为持久执行 capability。b2 负责真实双原生 Mac 来源构建、Node/MachO/Chrome、peer 解析与 relocation 等验收。此片不等于 whole T20 或完整 MVP。

纯 JavaScript 的观察不能提供原子整树快照，也不宣称抵抗恶意同 UID 父路径并发替换。调用者须保持输入静止，后续消费前重验。全仓 B05 注释覆盖门禁既有失败仍未豁免；本片通过不代表全仓质量门禁已通过。

## R1：首次读取类别与证据角色预算

已知源码和五树库存先按声明准入：所有 `package.json` 最多1 MiB，其它已知 `.json` 最多4 MiB；首次真实流读沿用同一类别上限。包含来源包 manifest、依赖包 manifest、引擎 package.json/package-lock.json/inventory.json/dependencies.json，不能等后续解码或重读才补上限。普通二进制源码和原归档继续使用既定2 GiB额度；归档角色不因任意文件名带 `.json` 被误分类。AST16/64 MiB 规则不变。

成功读取记录与 evidence 角色准入分别维护。源码副本或原归档先读过某个 Ref，不免除它后来首次作为工具、命令、SDK、inspection、optional-decision、proof 等 evidence 消费时的64 MiB累计收费；同一 Ref 后续 evidence 重复消费不双计。来源角色本身不占这份 evidence 预算，checkedEvidence 仍只列实际核字节成功的去重记录。

## 有界归档 prepare

`runtime-payload-archive.ts` 提供 `intakeRuntimeArchives(bytes, expected, options): Promise<IntakeResult>`。options 为 `{inputRoot, outputParent, candidateName, signal?}`；入口首次 await 前取得私有原字节、独立冻结 expected、选项标量及 signal 引用，然后真实调用同一输入核验器。内部共享准入每次创建新所有权字节，不 memo，也不把可写 TypedArray 假称为冻结对象。

在 `apps/runtime` 工作目录执行以下构建工具，五个 flag 必须各出现一次；路径都必须是显式绝对路径，candidate 为不超过64字符的单个可移植 ASCII 组件：

```sh
node --import tsx scripts/prepare-macos-runtime-archives.mjs \
    --inputs /absolute/inputs.json \
    --expected /absolute/expected.json \
    --input-root /absolute/input-root \
    --output-parent /absolute/controlled-output \
    --candidate candidate-id
```

成功 stdout 只有完整 `IntakeResult={directory,receiptSha256,receipt,committed:true,cleanup}` JSON。目录为 `archive-intake.json`、`snapshots/node.tar.gz`、`snapshots/chrome.zip` 与 `trees/{node,chrome}/<原topDirectory>/...`。归档目录和普通文件实际权限固定0700/0600，原 mode 只保留在回执；原始链接完整记录为逻辑成员，**不创建物理 symlink**。ArchiveMember 只记录实际 entries；缺省 parent 推导用于落地与链接解析，不伪造原目录模式。回执及嵌套字段深冻结，receiptSha256 对应 canonical 原始回执字节。

先 held FD 复制并核对两份独立 exclusive 快照，完整第一遍扫描实际长度、摘要、CRC、路径与链接图，再计算剩余空间，从同一快照第二遍逐成员对照后提取。五树与两归档有效路径共享40000成员、1024链接、16 GiB正文；正文含逻辑目标 UTF8 字节。树 fileBytes 本身仍只表示普通文件。单文件/原归档各2 GiB；路径1024、组件255、深度64、链接跳数32；回执最多4 MiB，实际成员累计时即收费，最终完整规范字节再核上限。

仅使用锁定 tar7.5.22/yauzl3.4.0 与 Node24 `zlib.crc32`。tar 的 gunzip 完整消费到 trailer，公开 Header framing 检查 checksum、完整正文/padding、双零终止及不超过1 MiB的零尾；支持 File/Directory/SymbolicLink、受限 PAX 与 GNU longname/longlink，拒绝 hardlink/special/sparse、size 覆盖或未知 meta。meta 单64 KiB、累计4 MiB、计数40000；真实解压流另限16 GiB+64 MiB。PAX 仅单行 ASCII 的 path/linkpath/mtime/atime/ctime/uid/gid/uname/gname，每个唯一字段由公开 Pax.parse 实际解释并经 encodeField/parse 往返确认；静默丢弃的错误长度、未知或重复字段均拒绝，不宣称支持全部 PAX。

ZIP 逐 entry lazy 读取，核 local 原文件名/flags/method 与 central 一致、安全整数边界及 local header/data 区间互斥；只接受未加密 stored/deflate，bit3 可接受。每个实际解压流包括空目录与链接都核最终长度和 CRC。这里只承诺公开 API 可证的范围、文件边界、流长/CRC 和库报错；**不宣称验证 descriptor、EOCD/ZIP64 全语法或 central directory 与 payload 全域不重叠**。ZIP streamBytes 是已完整 hash 的快照长度，tar 则是第一遍真实解压流长度。

Node links 全集精确匹配独立 NodeReceipt.inputLinks。Chrome 路径加 browser/ 后精确匹配独立 layout.allowedLinks。所有声明 Framework 根在链接遍历前逐个核独立 bundle 的明确前缀与非空 basename，包括实际/允许链接集合均为空的根；逐跳仍受同一 Framework 根约束。所有链接无悬空、越界或超过32跳；真实目录与目录别名组成有界图做迭代环检，合法重复别名不展开虚拟树。此结果完成原归档事实检查，未完成 npm 包内容/图、完整 Chrome 产品布局与 MachO/执行来源验收；b1a 原报告的固定 pending 保持原语义。

输入输出真实根不重叠且无 symlink/ASAR 祖先，受控父目录由调用者持有。独占当前 candidate 锁，不覆盖现有目标/锁，不按 glob 清理旧目录。空间依据实际快照、扫描正文及保守元数据计划；reserve=max(16 MiB,ceil(remainingWrites\*5%))，每阶段、新条目和每8 MiB写入再核 statfs，仍处理真实 ENOSPC/配额失败。只删除 nonce、parent/root/lock inode 与所有 writer 关闭均确认的自有 scratch；观察替换或关闭不确定时保留并报告 INCOMPLETE。

I 的独立来源身份观察在初次 b1a 后建立，涵盖实际 Ref、五树成员、父目录及宿主祖先；复制和收尾重核，再次真实调用 b1a。它不能继承 b1a 更早私有观察，不能保证发现两个观察边界之间所有同字节 inode 替换，也不提供敌对同 UID 下的原子整树或 NOREPLACE rename 保证。输入应保持静止。

全部来源、快照及落地内容复核、回执写入和 fsync 后，最终取消检查紧邻同 FS rename。rename 或最终内容确认不确定时抛 PAYLOAD_COMMIT_UNCONFIRMED，保留目录事实；已确认提交后取消不撤回。仅锁/元数据清理失败时仍返回 committed:true/cleanup:INCOMPLETE，CLI stderr 稳定警告。首 SIGINT/TERM 停止并等待自有资源关闭，二次信号或五秒期限以130/143、INCOMPLETE退出，保留可能仍有 writer 的 scratch；SIGKILL/断电没有清理保证。错误仍是冻结 RuntimePayloadError；原三个构造参数兼容，末尾可选上下文只复制 phase/candidateDirectory 标量，旧输入调用继续 INPUTS/null。

产品不需要 Python，不执行归档成员，不下载或安装内容，也不生成 Runtime 候选、签名、角色/engine 晋升或 ready。微型 ZIP 测试夹具需要开发机 Python3 标准库 zipfile；这不是已安装 Runtime 的依赖。下文 S 会重新核原 bytes/refs 并重新 intake，旧成功结果不构成持久 capability。

提取 sink 的受控文件系统错误在真实事务写入边界先统一分类，再经过 tar/ZIP 适配器；ENOSPC/EDQUOT 保留为 PAYLOAD_DISK_INSUFFICIENT 及原 causeCode，其它固定 errno 保留为 PAYLOAD_IO。未知错误和压缩格式/CRC 错误仍沿各适配器原路径处理，不把任意 parser 错误映成 IO；首错误不会被次要关闭故障覆盖，关闭不确认仍保留 INCOMPLETE。

## 完整静态 Runtime stage

`runtime-payload-stage.ts` 提供 `stageMacRuntimePayload(bytes, expected, options): Promise<Readonly<PayloadResult>>`。它接收相同原始 recipe、独立 expected 及 `StageOptions`，首次 await 前取得私有字节和固定选项，再真实重调 b1a 与 fresh intake；不接受旧报告代替本次核验。

从 `apps/runtime` 工作目录执行：

```sh
node --import tsx scripts/stage-macos-runtime.mjs \
    --inputs /absolute/inputs.json \
    --expected /absolute/expected.json \
    --input-root /absolute/input-root \
    --output-parent /absolute/controlled-output \
    --candidate candidate-id
```

五个 flag 必填且各一次，无环境默认。JSON held-FD、4 MiB 上限、SIGINT/TERM、二次信号与五秒期限沿用 prepare；成功 stdout 只有完整 `PayloadResult`，cleanup INCOMPLETE 或提交后取消有稳定英文 stderr 提示。失败不输出成功 JSON。

候选固定为 `runtime/ + payload-receipt.json + input-evidence/`。Runtime 包括同原 Node 普通成员逐份独立复制的三个 role（不同 inode、nlink1）、完整 npm 与全部依赖/peer 实例和普通 `.bin` 模板文件、entry/chunk/assets、八个 execution MJS、生产 dependencies 原 nested 布局、两个产品 native、完整所选 engine 文件、Node LICENSE，以及 Chrome 整个 top 目录（含 app 外资源/许可）。只允许独立 Chrome Framework layout 的链接；不把原 Node bin/npm 或 bin/npx 作为全局命令，也没有 role 或 npm symlink。固定 root package 是 `{"private":true,"type":"module"}\n`。

npm 先落入 work/views 的真实物理投影，以最终逻辑 `npm/...` 库存、树外 inventory 与 NodeReceipt 正文交独立 InputReader 和共享 `verifyPackageContents`。所有 package 自有树、完整依赖/optional-peer 声明、bin、resolution consumer/target 都真实闭合；native bin inspection 使用原 inputRoot 的第二个 reader。普通文件链接只在树内每跳可核且终点为普通文件时逐份物化，Origin 保留每个 raw target 摘要和终点摘要；目录 alias 拒绝。bin sourceAlias 原链先核，work profile 仅创建受审归一相对链接供物理核验，最终跳过原 alias 并在原 target 保持不动的前提下生成普通0755 shim。模板只相对定位自身 runner 和目标，完整转交 argv，没有宿主绝对 Node 或 PATH fallback。

生成器固定绑定二十个实际模块源码/CLI、contracts 实际入口及 validator/schema、根锁字节：来源由固定 module URL 和实际 `import.meta.resolve` 定位，同时匹配 SourceBinding 和 inputRoot 副本，生成前后复验。宿主0600源码使用 held-FD raw input 后独立核长度/摘要，输入源码副本保留严格 Ref 模式；不修改源码权限。这是受控 checkout 一致性，不能认证已加载机器指令、第三方包真实性或外部构建来源。

S 对 fresh ZIP 快照另用同一 yauzl 公开 metadata 作有限消费者检查：每个 entry 必须 Unix host3、明确非零且支持的 Unix filetype/permissions，并与 I member 集合逐项相同。DOS 或缺模式拒绝 PAYLOAD_ARCHIVE_UNSUPPORTED。它不另解压、不重复收费同一资源，也不补造 ZIP 全语法验证。I 的内部 prefix64/1024 缩限、ZIP mode fallback，以及旧 b1a Framework-name Minor 仍延期 T22/final review，没有因 S 拒绝政策而标记修复。

work 与 final 为独立事务；nested I 的 COMMIT_UNCONFIRMED、抛出或返回 cleanup INCOMPLETE、未知异常均保留 work 父目录，final 清理成功不能抹掉子 writer 未知事实。正常 I 关闭确认后才可清理 work。runtime profile 在 held FD 内设置并审计安全四 mode 与0755目录，默认 intake0700/0600行为保持。最终 Runtime 路径预算去掉固定容器后遵 D3a64/1024，现 I 缩限未绕过。目录 chmod/sync 的第一错误在关闭异常之后仍保留，次要 close 只另记清理不确定；无首错时关闭异常仍传播。空间计划按当前已占 work 与尚待写 final 的真实独立副本分阶段计费，保留动态 statfs/ENOSPC/EDQUOT 边界。

写完完整 runtime、shim 和 Chrome links 后生成 v2，先实测 scratch/runtime，再写包外 receipt 与 input-evidence（原 recipe、独立 expected、本次 intake receipt、来源 binding/锁/小 receipts 和必需 evidence）。完整收尾重验原来源及实际代码后同 FS rename，锁收尾前在 **实际 final/runtime** 再跑 D3a 并匹配同一 manifest SHA。无法确认提交后内容则保留候选并报 COMMIT_UNCONFIRMED；内容已提交且核验成功，仅锁或 work 收尾失败仍返回 committed:true/cleanup:INCOMPLETE。

`PayloadResult` 深冻结，包含 kind、candidateDirectory、runtimeDirectory、receiptSha256、最终路径 inventory、committed:true 和 cleanup。外部 receipt status 固定 `DEVELOPMENT_UNSIGNED_STATIC`，files 包含 manifest，counts 沿 D3a 排除 manifest；inputReceipts 使用候选相对路径且逐份实核，receipt 自身 SHA 仅在 Result。复制证据总额64 MiB在完整 inputReceipts 形成后检查，包含 copied refs、原 inputs.json、独立 expected.json 和 archive-intake.json；这项固定配额独立于磁盘空间计划，不按相同 SHA 去重实际副本。原 Node/Chrome SHA、源码 SHA 与未签名候选身份分别保留。

此 stage 不执行目标 Node、MachO、Chrome、peer resolve，不做 native ABI 装载、签名、安装、GUI、Keychain/Cookie 或 ready 晋升。双原生 Mac 来源构建和实际运行仍属 b2/D3c。全仓 B05 >40% 注释门禁仍 FAIL、未豁免，本片成功不等于 whole T20 或 MVP 完成。
