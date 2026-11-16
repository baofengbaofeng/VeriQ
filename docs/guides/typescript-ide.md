<a id="veriq-typescript-与-pycharm-配置"></a>
# TypeScript IDE

## 原因与修正

VeriQ 的 Node 24 / tsx 源码执行路径会显式导入 `.ts` 文件。
原来只有 Runtime 和部分 Electron 命名配置开启 `allowImportingTsExtensions`，
共享配置及部分 IDE 默认发现的项目没有开启，因此同一文件在不同消费者中可能报告 TS5097。
此外，TypeScript 默认向父目录查找 `tsconfig.json`；
只有 `tsconfig.host.json` 等命名文件，不能保证直接打开文件时 IDE 会选择正确配置。

共享配置现已统一开启 `allowImportingTsExtensions`，同时保留 `noEmit: true`。
补充的标准配置让 IDE 按所在目录发现项目，未改写导入路径，也未屏蔽诊断。

| 入口 | 范围与用途 |
| --- | --- |
| 根 `tsconfig.json` | 原先没有专属项目的跨工程测试、集成夹具与共享 UI；使用 Bundler/ESNext 和 JSX，仅作源码检查 |
| `scripts/tsconfig.json` | 仓库根构建脚本，覆盖 `.ts` 和 `.mts`；保留 NodeNext 与 Node 类型 |
| `apps/desktop/tsconfig.json` | 复用 host 设置，覆盖桌面非 renderer 源码、测试、打包脚本和配置入口 |
| `apps/desktop/src/renderer/tsconfig.json` | 继承既有 renderer 配置，保留 JSX、DOM 与 Vite 类型环境 |
| 既有 Web、Runtime 与 packages 配置 | 继续使用原来的入口和范围，并继承共享的导入扩展名选项 |

根配置不是全仓统一构建工程；各包继续使用自己的发布和检查入口。
桌面正式检查仍显式选择 `tsconfig.host.json`、`tsconfig.renderer.json` 和 `tsconfig.packaging.json`。
根脚本配置补齐先前遗漏的 `build_runtime.mts`，后续类型检查须覆盖它和它的实际依赖。

## 运行与发射约束

允许 `.ts` 导入不意味着普通 JavaScript 可以直接加载尚未处理的 TypeScript。
Node / tsx 源码执行、Bundler 构建以及产物消费必须继续走各自已定义的流程。
不能把源文件中的 `.ts` 批量替换为 `.js`，否则可能破坏源码直接运行。

TypeScript 5.9 要求此选项与不输出 JavaScript 或输出时正确改写扩展名的方式配合。
共享配置仍不发射文件；Web 的桌面类型产物仍为 `emitDeclarationOnly: true`，因此两者合法。
`scripts/build_engine.mts` 与 Runtime 的工作区 JavaScript 生产器显式构造编译选项，
没有继承共享配置，仍按既有普通 JavaScript 与声明输出策略运行。
本次没有添加 `rewriteRelativeImportExtensions`、改动产物格式或改变平台执行引擎。

## PyCharm 使用方式

1. 更新仓库并完成正常的冻结依赖安装。
2. 在设置（Settings）→语言与框架（Languages & Frameworks）→TypeScript 中启用 TypeScript 语言服务（TypeScript Language Service）。
3. 在 `TypeScript package`（TypeScript 包）中选择本仓库依赖中的 TypeScript 5.9.3，避免使用 IDE 内置旧版本。
   可选择 `apps/web/node_modules/typescript` 或其他已安装同版本的工作区包路径。
4. 若界面仍缓存旧诊断，重启 TypeScript 服务或重新打开项目，使新增配置被发现。

本次只针对配置归属和 TS5097；未安装依赖导致的模块解析错误及既有类型问题须独立处理。

## 验证交接

已使用仓库锁定的 TypeScript 5.9.3 和共享配置完成内存中两个源文件的最小编译器诊断：
修复前报告 TS5097，修复后无该诊断；未写入或发射 JavaScript。
静态发现检查覆盖 182 个含显式 `.ts` 导入的已跟踪源文件，最近的标准配置均包含该文件且启用该选项。
15 份配置的扩展名选项约束检查未发现 TS5096/TS5097 或项目引用相关配置冲突。
这些是定向诊断与配置核对，不是全仓类型检查，也未直接操作用户本机 PyCharm。

本轮沿用代码优先安排，不执行完整测试、构建或 CI。
后续 V09 应在完整冻结依赖环境核对 IDE 项目发现与各包正常类型检查。
补充检查 `apps/web/tsconfig.desktop.json` 的声明输出选项，确认没有 TS5096；
发行验证仍使用既有正式构建流程，不能把 IDE 不再报告 TS5097 当作全部类型或打包验收通过。
