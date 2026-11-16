# ADR 0022：生产依赖命令冲突的内部别名

状态：代码实现决策，验证待执行。日期：2026-11-16。

实际 `@playwright/test` 与其 `playwright` 依赖均声明名为 `playwright` 的命令。原有“保存每个包的全部 bin”与“每个安装层每个命令只能一个 aliasPath”的组合，无法同时表示真实 hoisted 安装。删除一个声明、假造原生检查或任意选择公共命令均不可接受。

保留实际安装中公共别名指向的 owner，公共路径仍为 `<installLevel>/.bin/<name>`；必须从真实别名目标确定，不能依赖包遍历顺序。同层同名的其它声明使用内部路径 `<installLevel>/.bin/.veriq/<sha256(owner.id)>/<name>`，摘要为完整十六进制 SHA-256。该内部命令没有原始物理别名时 `sourceAlias=null`，不声称它由 pnpm 创建。

现有 Bin DTO 不变。生产器、图引用检查、库存和 shim 生成统一认可普通路径或此精确派生路径，继续拒绝任意别名、重复路径和错误 owner。原始包正文、目标位置、目标摘要、锁与依赖解析不变；shim 使用按真实目录计算的相对路径，不能假设固定层数。

这项决策只解决内部产物的完整表达，不授予来源信任或执行批准。后续 V04/V05 必须验证实际公共 winner、两个包声明完整保留、私有 Node/native shim、嵌套安装层、篡改 owner/摘要/路径拒绝和实际目标 Node 解析。

补充的真实依赖边界：`@esbuild/<target>` 可只有真实二进制子路径而没有 package 根入口。因此声明依赖边的 Node 解析见证可以使用该 alias 本身或包 alias 完全相同的真实子路径；必须保留实际 Node 执行、consumer、resolvedFile 和正确实例 owner，不能按前缀误认其它包。入口/执行文件中的 RootBinding 仍要求原字面 specifier 精确匹配。该见证只证明已记录的声明与物理 owner 一致，不声称穷举全部动态加载或条件 exports。验证任务需覆盖不可导出子路径、同名前缀包、错误 owner 与 RootBinding 字面不匹配。
