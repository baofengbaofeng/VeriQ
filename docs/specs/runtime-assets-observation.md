<a id="veriq-mac-官方资产获取与观察"></a>

# Runtime Assets Observation

本片提供固定官方资产获取 CLI、原归档观察器 CLI 和双原生 Mac CI 的源码实现。真实 Mac 资产 job 尚须由 root 在源码独立审核后启动并逐架构复核。它不生成 Runtime、独立 Expected、npm 内容图或批准布局，不执行归档内 Node、Chrome、Electron 及原生插件，不访问系统凭据、Keychain 或信任存储。

来源始终是 `UNREVIEWED_SOURCE`，签名始终是 `NOT_VERIFIED`。Node 只声明 `MATCHED_PINNED_HTTPS_TEXT`，Chrome 只声明 `BODY_HASH_OBSERVED_ONLY`，布局始终是 `REQUIRES_LAYOUT_REVIEW`。这些是本次有限开发观察政策，不是永久发布信任政策；成功没有 `PASS_RUNTIME`、ready 或安装验收含义。

固定版本为 Node24.22.1、Chrome158.0.8127.18、Playwright1.65.0、revision1254。开发包的 engines 声明和通用 CI 仍为 Node24 系列。本片没有全局版本下限变化。

从 `apps/runtime` 工作目录执行，所有参数各出现一次；宿主 JSON 路径及两个根必须绝对，候选名是单个可移植 ASCII 标识。拒绝缺失、重复、未知、尾随参数及隐式环境默认。

```sh
node --import tsx scripts/acquire-macos-runtime-assets.mjs --arch x64 --source /absolute/source-observation.json --input-root /absolute/source-root --output-parent /absolute/acquisition-parent --candidate acquired
node --import tsx scripts/observe-macos-runtime-assets.mjs --assets /absolute/acquisition-parent/acquired/assets-input.json --input-root /absolute/acquisition-parent/acquired --output-parent /absolute/observation-parent --candidate observed
```

`--source` 是最多4 KiB 的普通 JSON 文件，含且仅含 `{commit,evidence}`；commit 为小写40hex，evidence 是严格 `{path,sizeBytes,sha256}`，path 固定为 `evidence/source.json`。它不是 URL、命令或程序。来源证据最多1 MiB，其 `SourceFacts` 必填字段为 `schemaVersion:1`、`kind:"ASSET_OBSERVER_SOURCE"`、commit、十进制字符串 runId、正整数 runAttempt、arch、15.x 数字 osVersion、`nodeVersion:"24.22.1"`、实际工具 nodeSha256、files。files 恰好是模块 `ASSET_SOURCES` 的十九个仓库键，绑定四个资产脚本、I 扫描器/Tx/input/tree/receipt/graph、D3a manifest/node-version、实际解析的 contracts 三文件、锁和本片工作流。

首次 request 前，获取器以已持有的文件描述符读取私有证据、独立核原字节长度与 SHA、严格验证全部元数据，再核实际模块 URL 及 contracts 解析入口的十九个宿主文件字节。最后保留初次身份并重新核验。JSON 自报 commit/run 不是认证；真实 CI 的 checkout/运行事实由外层佐证。此一致性也不证明已加载机器码或全部第三方依赖真实性。

HTTPS GET 严格顺序为校验和、Node、Chrome，默认 TLS 验证及 identity 编码，没有镜像、传输、信任、版本或限额覆盖。CLI 拒绝显式代理、额外 CA 及 TLS 覆盖环境；CI 清除相同变量。Node 与校验和拒绝所有跳转；Chrome 只允许 CDN 直接200或一次跳到同版本、同架构的精确 Google Storage URL。只保存批准 URL、状态、location、Content-Length 和完整正文 Ref，不保存任意响应头或错误页。

| 对象           | 原字节长度 | 原字节 SHA256                                                      |
| -------------- | ---------: | ------------------------------------------------------------------ |
| SHASUMS256.txt |       3171 | `fdfbffc969c0f604beff0124d409b33a43b53f5c681d6220f80023e0d6df9dc4` |
| Node x64       |   54382566 | `d132557e7ee2b85af08b0c8c34338e65c6430f2238d01f727728ef42dc83b035` |
| Node arm64     |   53062778 | `89c682593d76cd44233fa53b1563264e7de9cbb189cad169135c5b4fadfbc0a7` |
| Chrome x64     |  212863194 | 仅获取后观察，不是独立固定摘要                                     |
| Chrome arm64   |  199683801 | 仅获取后观察，不是独立固定摘要                                     |

校验和两条 Darwin 记录必须严格唯一并匹配。Chrome 长度来自本候选保存的 HEAD 事实，不能当作发布签名。响应头限16 KiB、headers/无进展各30秒、单归档10分钟、总获取15分钟，无重试或续传；正文逐块≤64 KiB，硬限分别64 KiB、64 MiB、256 MiB且精确长度优先。超出声明立即拒绝并销毁 owned 请求/流。事务按实际计划复查空间，每8 MiB再查，保留至少16 MiB或5%。

获取阶段输出六文件：`archives/{node.tar.gz,chrome.zip}`、`evidence/{source.json,fetch.json,SHASUMS256.txt}`、`assets-input.json`。默认空 snapshots/trees 可保留。输入 JSON 必填固定身份字段、source、node/chrome Ref、fetchEvidence Ref；全部 UTF8 严格、未知字段拒绝、非负安全整数、小写64hex 摘要，结果深冻结。

观察器只以 `InputReader.input` 读取小元数据并独立核 Ref；大归档只通过 `Tx.observeRefs` 身份登记及 `Tx.snapshot` 真实已持有的文件描述符流 hash/长度核验。新 Ref 入口最多8个唯一普通文件，允许0400/0600/0444/0644，单文件≤2 GiB/合计≤4 GiB+64 MiB，不改变原五树 observeSources 政策、配额或默认私有权限。元数据原读取器与事务来源观察都保留到最终复验，初读和登记之间的同字节替换也不能覆盖早期事实。

观察器输出 `observation.json`、`members/{node,chrome}.json`、`evidence/{source.json,fetch.json,SHASUMS256.txt,zip-modes.json}`、`snapshots/{node.tar.gz,chrome.zip}` 和默认空 trees。仅快照保存压缩包；没有普通归档成员提取或符号链接创建。fetch.json 中的历史 body Ref 保持获取制品根语境，真实观察器快照映射由 archives.kind 固定顺序给出。

`ArchiveObservation` 记录 snapshot、topDirectory、members Ref、显式/有效条目数、file/directory/link 计数、展开/流字节、最大深度/路径字节、CRC、ZIP local/data 范围和可空 modeEvidence。成员文档保留归档顺序；推导父目录只计有效条目。ZIP 原模式逐条保留 host、externalFileAttributes、rawMode，只有 host3 且非零且有 Unix file/dir/link 类型才标 `EXPLICIT_UNIX`，其它为 `MISSING_OR_DOS`；不能把 I 的合成默认权限伪装为原模式。

两个归档共用空 `ArchiveBudget`：40000有效路径/1024 links/16 GiB，成员 JSON 合计4 MiB、原模式4 MiB、observation4 MiB。扫描只保证实际 gzip 流/ZIP 每条 CRC、有界成员和公开 local/data 区间，不承诺全部 ZIP 语法、全链接逐跳闭包或最终 stage20000成员限制。布局观察只分类真实 bundle/executable、直接 Framework 根、其内部链接候选和外部 links；缺对象或外链可产完整待审观察，格式、路径、CRC 失败则拒绝。

成功 stdout 只有 Result JSON。获取 Result 为 `MAC_RUNTIME_ASSETS_ACQUISITION_RESULT`，含 directory/input Ref/status/committed/cleanup；观察 Result 为 `MAC_RUNTIME_ASSETS_OBSERVATION_RESULT`，含 directory/observation Ref/status/committed/cleanup。Ref 绑定真实最终文件原字节，无结果自哈希。失败 stderr 为固定英文 code/phase/cleanup；获取失败另提供固定阶段与实际收到正文块字节的有界 JSON，不包含正文。部分下载不进入成功 fetch.json。输入错误属 INPUTS，下载/扫描属 INTAKE，发布属 PUBLISH；网络/TLS/timeout 为 PAYLOAD_IO、超限为 PAYLOAD_LIMIT、固定摘要不符为 PAYLOAD_ARCHIVE_HASH。

SIGINT/TERM 取消本次 owned 请求、读取器和写入器，首次给5秒关闭期限，二次或期限到达退出130/143并报告 INCOMPLETE。未确认关闭或最终内容时保留所属制品，不能递归删除未知异步写入器；已 rename 提交的目录不因取消回滚。COMMIT_UNCONFIRMED 不宣称提交撤回。

工作流 `.github/workflows/runtime-payload-macos.yml` 只允许手动调用及 root 审核后的 `codex/veriq-mvp-completion` 分支 push，push paths 精确限定十九项来源键。新增工作流在默认分支尚不存在时不能依赖手动派发，首次真实运行由 root 独立审核后推送自有分支触发；作者不 push 或派发。手动 source_ref 必须是完整40hex并等于 github.sha；两种事件都在安装及源码执行前断言实际源码检出 HEAD 等于 github.sha，并在获取前后复核。只有原生 macos-15-intel/x64 和 macos-15/arm64，fail-fast:false、contents:read、固定 action SHA、Node24.22.1、pnpm11.25.0、冻结的依赖、ignore-scripts；没有 PR/schedule、Rosetta、secrets 或部署能力。

每架构只上传两份7天保留制品：`veriq-macos-assets-observation-${arch}` 保存完整小证据/源码身份/步骤/Result/摘要清单，metadata≤16 MiB、日志≤8 MiB；`veriq-macos-assets-archives-${arch}` 仅保存观察器两份原始压缩快照，compression-level0、≤600 MiB，不重复获取阶段大包。失败 always 保存有限步骤 STARTED/PASS/FAIL/NOT_RUN、code/cleanup、已产生且稳定的小证据，未运行不伪造 Result，未确认关闭不扫描活跃临时工作目录。日志截断明确标记，摘要只绑定保留文件。

root 独立下载和核验小制品，并检查大制品的服务端元数据；容量不足的本地环境不下载大包，也不虚称已在本地重算原压缩摘要。后续 b2b 在真实 Mac job 重新核原归档摘要后才继续生产 npmGraph/五树/Recipe；真实两份 job、原 ZIP mode/Framework 逐架构审核仍是本片完整验收条件。现有 I prefix/ZIP 回退路径、旧 b1a Framework 等登记限制没有被本片修复，所有 F01-F14 与四个目标平台的完整 MVP 验收仍然必需。

回归校验文本现以完整3171原字节保存在已提交的 `tests/fixtures/runtime-assets.ts` 字符串中，每次导出独立字节副本；测试直接核固定摘要、两个架构记录和变异拒绝，不依赖私有 `.superpowers` 证据目录。小镜像回归只复制测试及三个夹具模块，借用现有只读脚本/依赖链接并断言私有目录不存在；它证明该目标回归可在缺少私有证据的上下文运行，不等同全新依赖安装或完整克隆验收。

小制品的最终收集器现在直接在工作流中执行：先按真实 size/type/nlink 核输入，metadata 和非安装日志超限在打开正文前拒绝；安装日志只读取32700字节前缀，附明确截断标记，摘要仅对应保留文件。收集器在独占私有草稿中写入、核全部文件及清单自身的实际字节预算，并在固定 job-owned `upload/` 最终目录复核，随后才写 `ready`、固定路径及清单摘要。上传条件同时要求完成标记和该精确路径，原始未检查 `metadata/` 永不直接上传。

配额、IO、截断或清单失败时，完整草稿不获得上传资格；独立微型回退路径仅含 `failure.json` 和真实摘要清单，明确 METADATA_COLLECTION 为失败、FULL_ARTIFACT_PROMOTION 为 NOT_RUN，不猜测其它阶段或伪造 OBSERVED。未知关闭的旧草稿保留并记 INCOMPLETE，新回退路径有独立关闭状态；若连回退路径都不能独占创建、写入或复核，则没有 ready 标记、没有可上传目录，步骤诚实失败。最终完整或回退路径集合都把 manifest 自身计入 metadata≤16 MiB，日志≤8 MiB，仍仅占每架构既有小制品；两个原压缩快照的独立 archive 制品政策不变。

工作流收集回归通过已锁的 PyYAML6.0.3 提取真实 YAML 内的生产 inline Node 段，在自有临时根执行并检查实际标记、路径、字节、摘要和上传门控。开发环境应先按仓库指南备妥 Runtime 锁定依赖和 `uv sync --project apps/srv --frozen --all-groups` 对应的既有服务端开发环境；测试本身只执行 `uv run --offline --no-sync --project apps/srv python` 并将 UV_CACHE_DIR 指向测试自有目录，不安装/下载依赖，不增加产品运行时 Python 依赖。只运行两份资产测试可用 `node --import tsx --test tests/runtime-assets-acquisition.test.ts tests/runtime-assets-observation.test.ts`。边界案例用顺序稀疏自有文件并先核空闲与实际分配，不生成官方归档或请求网络。

缺少编排步骤时，收集器现在使用固定 step-level GitHub outcome 事实：只有 bind/setup-node/dependencies 中明确的前置失败序列且 observe 为 skipped，才在私有草稿合成 `steps.json`，记录 SETUP=失败（PAYLOAD_IO、NOT_NEEDED）以及 ACQUIRE/OBSERVE=NOT_RUN。现有有效步骤保留原字节和摘要，不会被合成内容覆盖；新步骤同样进入清单、两次审计和实际 metadata 预算。未知、已开始、失败或取消的编排若缺失有效步骤，则只产生带 `MISSING_EXECUTION_EVIDENCE` 原因的有限失败回退路径，不宣称 FULL 或推断 CLI 未运行。收集结果的 FULL 仅表示含这些真实失败事实的完整文件集合，不能把 setup 失败解释为 OBSERVED 或 Runtime 成功。

归档格式拒绝现在可在原公共错误行之后输出一条 `ASSET_ARCHIVE_REJECTION` 诊断 JSON。它通过错误身份的私有弱表保留实际首错，事务清理完成、错误归一化后才由观察器 CLI 写到既有 stderr/observe.log；不增加输入字段、CLI 参数、错误枚举属性或公开入口参数，`observeMacRuntimeAssets(bytes, options)` 仍为两个参数，成功 stdout 不变。

事件包含 schemaVersion1、node/chrome、有限扫描阶段与十二个固定 guard reason，以及可空的原头/有效成员索引、路径摘要及编码、原始和有效模式、数值类别与成熟解析器已经读取的字段。tar 最多保存一个512字节头及64KiB元数据正文的完整样本、长度和 SHA；ZIP 只记录公开头字段，不保存普通成员正文。整个单行 JSON（包括 base64 膨胀及换行）最多96KiB，捕获失败或超限则省略事件，不把截断内容声明为完整事实。原分类、拒绝顺序、资源限额和清理规则不变；输出失败保留原退出码。

诊断属于未受信任且由当前十九个来源键实际字节绑定的观察证据，不授予格式准入、布局批准、Expected 或 Runtime ready。它复用既有日志和制品配额；真实双架构原归档的具体拒绝原因仍须在 root 审核后的原生 Mac CI 中观测，后续任何与冻结格式政策冲突的接受行为需要另行决定。

Stored（方法0）的 `0x6` 方法专属压缩选项位现在作为不解释的原始元数据保留，由同一固定成熟解码器读取正文。这是针对已观察到的固定 Chrome 条目和微型真实正文/CRC 对比所作的一项明确兼容准入修正；PKWARE 将这些位在 Stored 下称为未定义，并没有规定有效的 Stored 选项含义或普遍接受要求。原始 flags 不清零、不改写，local/central 的名称、方法和 flags 仍须完全一致；仅方法0/8与精确允许掩码 `0x80e` 不变，加密、强加密和未知位仍拒绝。Stored 压缩/解压长度一致、描述信息、完整正文长度与 CRC、公开区间、路径、模式、链接、预算及取消/清理规则保持原样。若其它方法或位触发拒绝，诊断中的 `storedFlags` 仍可表示原位存在，不能再将它单独解释为拒绝原因。

本次本地回归仅证明这一兼容边界与微型双快照观察，不能代替 root 后续完整原归档的双原生 Mac 扫描及逐架构模式/Framework 审核；首个已知拒绝解除后仍可能遇到其它独立问题。来源、签名与布局标签，以及 Expected、安装和 Runtime ready 的待验边界均不变。
