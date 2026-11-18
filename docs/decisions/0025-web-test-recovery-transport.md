# 0025 Web 测试恢复的传输与追踪边界

- 状态：协调者批准的 R03 Fix Round 4 限定修正，待独立复审。
- 日期：2026-11-17。
- 范围：仅认证 GUI 回归失败后的原管理员恢复，不改变正常 GUI 流程、服务权限或生产客户端。

Playwright Test 会自动追踪新建的 APIRequestContext；在 retain-on-failure 下，登录正文、Cookie 和 CSRF
可能在应用 catch 脱敏之前进入保留制品。其默认跳转行为还会把登录正文及自定义 CSRF 头转送跨源。
独立 Cookie 容器、最终错误脱敏和 dispose 都不能消除已经记录或转送的数据。

恢复请求改用公开的 Undici Client，绑定唯一 origin，按固定路径逐阶段请求，不使用跳转或重试拦截器。
独立的 tough-cookie CookieJar 负责标准 Cookie 解析、路径和域匹配。三阶段只接受 HTTP 200，先检查状态再解析正文；
每次请求包含正文读取的总预算为 5 秒，客户端、响应流和内存 Cookie 均在成功或失败后结算释放。
底层请求、JSON、Cookie 和资源清理错误只允许固定英文阶段信息进入报告，不保留原始秘密 cause。
恢复仍验证既有备用管理员的 email/admin 及已知目标的 id/email/true，并使用匿名、认证两个真实 CSRF 阶段。
调用方保留前端 origin 5173 和原 30 秒 GUI 预算。

| 包 | 精确版本 | 上游许可 | 用途 |
| --- | --- | --- | --- |
| undici | 7.30.2 | MIT | 新增直接开发声明，复用已有锁定解析，公开单源 Client |
| tough-cookie | 6.1.0 | BSD-3-Clause | 直接开发依赖，独立内存 CookieJar |
| tldts | 7.5.4 | MIT | Cookie 域规则的传递依赖 |
| tldts-core | 7.5.4 | MIT | 域解析的传递依赖 |
| tsx | 4.23.15 | MIT | 新增直接开发声明，复用已有锁定解析以执行 TypeScript Node 回归 |

五者均可在固定 Node 24 下使用，许可与 AGPL-3.0 兼容。Undici 无新增传递依赖；tough-cookie 使用成熟域名解析库，
不另造 Cookie 解析或通用认证框架。直接版本精确钉死，传递版本冻结到锁文件；无 Node、Playwright、浏览器、Electron
或产品依赖版本移动，Runtime 生产闭包不增加恢复工具。

官方 npm 元数据记录发布时间分别为 2026-11-05、2026-11-06、2026-11-15 和 2026-11-15，均满足
minimumReleaseAge: 1440；既有 tsx 4.23.15 发布于 2026-09-20。2026-11-17 对上述五个精确版本的 npm advisory bulk 查询返回空对象；
这只是当时的公告结果，不保证未来无漏洞，也不替代完整发行审计。严格 engine/peer、完整性校验及冻结安装策略保持。
实际新增解析只有 tough-cookie、tldts、tldts-core 三个包；Undici 与 tsx 均复用已有版本和闭包。
原始元数据、查询、上游 LICENSE 和哈希留在 `.superpowers/sdd/mvp-validation-20261117/r03-review/fix4/`。
分发物仍须保留上游版权、许可及适用 NOTICE，详见 [THIRD_PARTY_NOTICES](../../THIRD_PARTY_NOTICES.md)。

验证必须包含真实双环回跨源跳转 RED/GREEN、实际 Client/响应/Jar 释放，以及无浏览器的真实 Playwright Test
retain-on-failure 制品检查。后者使用运行时生成的合成哨兵扫描全部 ZIP 成员与日志资源，明确区分受控正文失败的
预期退出 1 和外层回归成功。正常 GUI tracing 不被禁用或修改。这些证据只证明恢复协议和诊断边界，不代表真实
Tornado、数据库、GUI、Runtime 信任或完整 hosted 流程验收通过。

永久入口 `pnpm --filter @veriq/web test:unit` 串行执行直接位于 `tests/unit/*.ts` 的 Node 回归。
探针位于嵌套 fixtures 目录且不使用 `.spec.ts` 名称，只由临时隔离配置选中，不能混入正常 GUI 或 Node glob。
既有 `test:e2e` 在 Playwright 前执行该入口；手动 web-full 工作流在 GUI 步骤之后、ready 成功且未取消时独立执行，
因此 GUI 失败不跳过安全回归。该步骤限两分钟，日志沿用现有七天制品范围；正常 release 六条命令、来源绑定和其它 jobs 不变。
