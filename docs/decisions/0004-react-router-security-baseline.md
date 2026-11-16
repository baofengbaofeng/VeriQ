<a id="adr-0004-react-router-7185"></a>
# 0004 React Router Security Baseline

- 状态：用户于 2026-11-10 接受。
- 决策：使用精确版本 react-router/react-router-dom7.18.5，保留 React18/Vite6 及 CSR 声明式模式（Declarative Mode）。
- 背景：最新 6.x 版本 6.30.6 仍在维护者公布的导航混合斜线处理漏洞影响范围内，修复范围从 7.18.0 开始。SSR 公告不适用于规划中的声明式 CSR 设计。
- 证据：https://github.com/advisories/GHSA-wrjc-x8rr-h8h6 ；上游发行及回移分析保留于依赖审计证据中。
- 后果：升级依赖、锁文件及生成文档，重新执行路由兼容性和相关测试。该批准不允许改变无关产品范围，也不表示无条件接受全部审计发现。
