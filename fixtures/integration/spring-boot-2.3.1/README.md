# VeriQ Spring Boot 2.3.1 HTTP example

独立 Java11/Spring Boot `2.3.1.RELEASE` 源码，真实 Bearer 角色、prepare/query/cleanup、参数绑定幂等、员工持久化查询、外部 TTL 维护、requestId/build SHA 和打包 OpenAPI。C06 未构建或执行。

完整前置、私有 POSIX 存储、Maven 命令、共享 demo UI 与 Python 标准库调用方式见[后端指南](../../../docs/guides/backend-http.md#java-spring-boot231)。不在 VeriQ 根新增 Java 锁或依赖安装步骤。

存储目录和文件不能为符号链接或授予组/其它用户权限；单进程文件锁与原子快照只适合小型受控示例。生产业务应替换为真实数据库事务/行锁，目录 fsync 级掉电恢复、多实例高可用与业务 SSO 不属于这个存储样例的承诺。
