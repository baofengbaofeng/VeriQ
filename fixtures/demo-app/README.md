# VeriQ controlled demo

真实 Python/Tornado + SQLite 被测业务示例，使用 `apps/srv` 已声明环境；不是 VeriQ 控制数据库。C06 新增 UI、code 归属查询、build/requestId 和 OpenAPI 更新尚未运行验证。

完整启动、网络、空间导入、真实编译发布和清理步骤见[示例指南](../../docs/guides/sample-workspace.md)，HTTP 身份/fixture 契约见[后端指南](../../docs/guides/backend-http.md)。

```sh
umask 077
mkdir -p /tmp/veriq-example-private
export VERIQ_DEMO_DATABASE=/tmp/veriq-example-private/demo.sqlite
export VERIQ_DEMO_BUILD_SHA=example-build-001
apps/srv/.venv/bin/python fixtures/demo-app/app.py
```

启动前由秘密管理器提供三份互异、至少24字符的环境令牌：`VERIQ_DEMO_BUSINESS_TOKEN`（editor）、`VERIQ_DEMO_FIXTURE_TOKEN`（fixture-service）、`VERIQ_DEMO_MAINTENANCE_TOKEN`（maintenance）。不支持硬编码默认密码。

默认 loopback8090；`VERIQ_DEMO_PORT`、`VERIQ_DEMO_BIND` 可显式配置。远程访问放到受控 TLS 代理后，localhost 总是实际 Runtime 自己。页面导航支持 `/?namespace=...` 或 `/?code=...`；普通业务身份仍须通过正常认证。

- `GET /build-info`、`GET /openapi.json`：目标构建和固定契约。
- `GET /me`、`POST /login`：真实身份/受控 Cookie 登录。
- `POST /prepare`、`GET /query`、`POST|DELETE /cleanup`：独立服务身份、参数绑定幂等和精确清理。
- `POST|GET /employees`：普通 editor 身份，namespace 或公开 fixture code 二选一。
- `POST /maintenance`：外部 maintenance 身份调用，limit≤100，按hasMore处理到期夹具；无内部Cron。

列表来自持久化 GET，行 id 通过 `data-record-key` 暴露，内容通过 textContent 写入。清理保留 CLOSED 墓碑，晚到写入在事务中拒绝。未知写入先查询，不自动重试业务 POST。测试阻塞路由仅存在于 `fixtures/test-support/server.py`，正常 demo 不提供。
