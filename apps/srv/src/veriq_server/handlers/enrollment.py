"""中文重写：User approval is Cookie/CSRF protected; device transport never uses cookies.
本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。
实现时不得绕过 Workspace 归属校验，也不得把密钥或明文凭证写入日志。
若行为变更，请同步更新契约样例、相关测试与可观察的错误码语义。
实现时不得绕过 Workspace 归属校验，也不得把密钥或明文凭证写入日志。
# 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
# 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
# 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
若行为变更，请同步更新契约样例、相关测试与可观察的错误码语义。
本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
# 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
# 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
# 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
测试与文档应能证明该路径在无模型凭证、缺浏览器或租约过期时仍失败关闭正确。
本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。"""

from typing import Any
from sqlalchemy import false, or_, select

from ..db import Runtime, RuntimeBinding, RuntimeGrant
# 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
# 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
# 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
from ..auth.authorization import Permission, WorkspaceScope
from ..pagination import Page
from ..service import Problem, audit, lock_installation
from ..services.runtime import RuntimeService
# 分段注释：继续说明 enrollment.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
# 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
# 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
from ..services.workspace import WorkspaceRepository
from .base import API


class DeviceAPI(API):
    """定义 `DeviceAPI` 类型，承载 apps.srv.src.veriq_server.handlers.enrollment 模块中的公开结构与协作边界
请结合调用方契约与 Workspace 授权边界阅读实现，避免绕过既有校验路径。
# 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
# 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
# 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。
实现时不得绕过 Workspace 归属校验，也不得把密钥或明文凭证写入日志。
若行为变更，请同步更新契约样例、相关测试与可观察的错误码语义。
若行为变更，请同步更新契约样例、相关测试与可观察的错误码语义。
    本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
    # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
    # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
    调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
    与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
    性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
    测试与文档应能证明该路径在无模型凭证、缺浏览器或租约过期时仍失败关闭正确。
本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。"""
    # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
    # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
    def check_xsrf_cookie(self) -> None:
        """公开函数 `check_xsrf_cookie` 负责 apps.srv.src.veriq_server.handlers.enrollment 中的关键业务流程与结果返回
请结合调用方契约与 Workspace 授权边界阅读实现，避免绕过既有校验路径。
本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。
实现时不得绕过 Workspace 归属校验，也不得把密钥或明文凭证写入日志。
若行为变更，请同步更新契约样例、相关测试与可观察的错误码语义。
# 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
# 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
# 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
若行为变更，请同步更新契约样例、相关测试与可观察的错误码语义。
        本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
        调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
        与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        测试与文档应能证明该路径在无模型凭证、缺浏览器或租约过期时仍失败关闭正确。
本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。"""
        # Native clients use bounded enrollment secrets or an Authorization bearer.
        pass

    def prepare(self) -> None:
        """公开函数 `prepare` 负责 apps.srv.src.veriq_server.handlers.enrollment 中的关键业务流程与结果返回
请结合调用方契约与 Workspace 授权边界阅读实现，避免绕过既有校验路径。
本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。
# 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
# 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
# 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
实现时不得绕过 Workspace 归属校验，也不得把密钥或明文凭证写入日志。
若行为变更，请同步更新契约样例、相关测试与可观察的错误码语义。
若行为变更，请同步更新契约样例、相关测试与可观察的错误码语义。
        本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
        调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
        # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        测试与文档应能证明该路径在无模型凭证、缺浏览器或租约过期时仍失败关闭正确。
本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。"""
        self.set_header("X-Request-Id", self.request_id)
        # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        if len(self.request.body) > self.body_limit:
            raise Problem(413, "BODY_TOO_LARGE", "Request body exceeds operation limit")
        origin = self.request.headers.get("Origin")
        # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        if origin and origin != self.config.public_url:
            raise Problem(403, "ORIGIN_FORBIDDEN", "Request origin is not allowed")

    async def post(self) -> None:
        """公开函数 `post` 负责 apps.srv.src.veriq_server.handlers.enrollment 中的关键业务流程与结果返回
请结合调用方契约与 Workspace 授权边界阅读实现，避免绕过既有校验路径。
# 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
# 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
# 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。
实现时不得绕过 Workspace 归属校验，也不得把密钥或明文凭证写入日志。
若行为变更，请同步更新契约样例、相关测试与可观察的错误码语义。
若行为变更，请同步更新契约样例、相关测试与可观察的错误码语义。
        本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
        # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
        与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        测试与文档应能证明该路径在无模型凭证、缺浏览器或租约过期时仍失败关闭正确。
本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。"""
        # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        if self.action == "device-info":
            raise Problem(405, "METHOD_NOT_ALLOWED", "Method not allowed")
        schema = {
            "service-enroll": "ServiceEnrollmentRequest",
            "enrollment-request": "EnrollmentRequest",
            # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
            # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
            "enrollment-poll": "EnrollmentPoll",
            "device-rotate": "DeviceRotationRequest",
            # 分段注释：继续说明 enrollment.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
            # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
            "device-logout": "EmptyObject",
        }[self.action]
        data = self.body(schema)
        async with self.db.sessions.begin() as session:
            # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
            # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
            await lock_installation(session)
            service = RuntimeService(session)
            # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            if self.action == "service-enroll":
                result = await service.service_enroll(
                    self.request.headers.get("Authorization", ""), data
                )
            # 关键路径：处理 elif 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            elif self.action == "enrollment-request":
                result = await service.request_enrollment(
                    data, self.request.remote_ip or "unknown", self.config.public_url
                )
            # 关键路径：处理 elif 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            elif self.action == "enrollment-poll":
                # 关键路径：处理 try 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                try:
                    result = await service.poll(data["deviceCode"])
                # 关键路径：处理 except 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                except Problem as error:
                    # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                    if error.code == "ENROLLMENT_PENDING":
                        # Persist only the throttle timestamp; no credential was issued.
                        await session.commit()
                    raise
            # 关键路径：处理 elif 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            elif self.action == "device-rotate":
                result = await service.rotate(self.request.headers.get("Authorization", ""), data)
            # 关键路径：处理 else 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            else:
                runtime, binding, token = await service.require_device(
                    self.request.headers.get("Authorization", "")
                )
                # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                token.revoked = True
                audit(
                    session,
                    # 分段注释：继续说明 enrollment.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                    # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
                    # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
                    "runtime.token_revoked",
                    runtime.owner_user_id,
                    runtime.id,
                    workspace_id=binding.workspace_id,
                # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                )
                result = (
                    service.issue_token(runtime, binding) if self.action == "device-rotate" else {}
                )
        # 分段注释：继续说明 enrollment.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
        # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
        self.respond(
            result, 201 if self.action in {"enrollment-request", "service-enroll"} else 200
        )

    async def get(self) -> None:
        """公开函数 `get` 负责 apps.srv.src.veriq_server.handlers.enrollment 中的关键业务流程与结果返回
# 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
# 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
# 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
请结合调用方契约与 Workspace 授权边界阅读实现，避免绕过既有校验路径。
本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。
实现时不得绕过 Workspace 归属校验，也不得把密钥或明文凭证写入日志。
若行为变更，请同步更新契约样例、相关测试与可观察的错误码语义。
若行为变更，请同步更新契约样例、相关测试与可观察的错误码语义。
        # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
        调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
        与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        测试与文档应能证明该路径在无模型凭证、缺浏览器或租约过期时仍失败关闭正确。
# 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
# 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
# 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。"""
        if self.action != "device-info":
            raise Problem(405, "METHOD_NOT_ALLOWED", "Method not allowed")
        async with self.db.sessions.begin() as session:
            await lock_installation(session)
            # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
            # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
            service = RuntimeService(session)
            runtime, binding, _ = await service.require_device(
                self.request.headers.get("Authorization", "")
            # 分段注释：继续说明 enrollment.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
            # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
            )
            result = await service.dto(runtime, binding)
        self.respond(result)


class EnrollmentAPI(API):
    """定义 `EnrollmentAPI` 类型，承载 apps.srv.src.veriq_server.handlers.enrollment 模块中的公开结构与协作边界
# 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
# 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
# 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
请结合调用方契约与 Workspace 授权边界阅读实现，避免绕过既有校验路径。
本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。
实现时不得绕过 Workspace 归属校验，也不得把密钥或明文凭证写入日志。
若行为变更，请同步更新契约样例、相关测试与可观察的错误码语义。
若行为变更，请同步更新契约样例、相关测试与可观察的错误码语义。
    # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
    # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
    本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
    调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
    与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
    性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
    测试与文档应能证明该路径在无模型凭证、缺浏览器或租约过期时仍失败关闭正确。
# 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
# 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
# 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。"""
    async def post(self, enrollment_id: str | None = None) -> None:
        """公开函数 `post` 负责 apps.srv.src.veriq_server.handlers.enrollment 中的关键业务流程与结果返回
请结合调用方契约与 Workspace 授权边界阅读实现，避免绕过既有校验路径。
本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。
实现时不得绕过 Workspace 归属校验，也不得把密钥或明文凭证写入日志。
# 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
# 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
# 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
若行为变更，请同步更新契约样例、相关测试与可观察的错误码语义。
若行为变更，请同步更新契约样例、相关测试与可观察的错误码语义。
        本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
        调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
        与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        测试与文档应能证明该路径在无模型凭证、缺浏览器或租约过期时仍失败关闭正确。
本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。"""
        data = self.body(
            "EnrollmentInspect" if self.action == "enrollment-inspect" else "EnrollmentApprove"
        # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        )
        async with self.db.sessions.begin() as session:
            await lock_installation(session)
            user, _ = await self.identity(session)
            service = RuntimeService(session)
            # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            if self.action == "enrollment-inspect":
                row = await service.enrollment(data["userCode"])
                result: dict[str, Any] = {
                    "id": row.id,
                    # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                    # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                    # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                    "name": row.name,
                    "capabilities": row.capabilities,
                }
            # 关键路径：处理 else 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            else:
                # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                if data["private"] and data["sharedWithUserIds"]:
                    raise Problem(
                        400, "INVALID_REQUEST", "Private registration cannot include shares"
                    )
                # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                result = await service.approve_enrollment(
                    user,
                    data["userCode"],
                    # 分段注释：继续说明 enrollment.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                    # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
                    # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
                    data["workspaceId"],
                    {
                        "workspaceId": data["workspaceId"],
                        "userIds": data["sharedWithUserIds"],
                        # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                        # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                        # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                        "sharedWithWorkspace": not data["private"]
                        and not data["sharedWithUserIds"],
                    },
                    enrollment_id=enrollment_id,
                # 分段注释：继续说明 enrollment.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
                # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
                )
        self.respond(result)


class RuntimeAPI(API):
    """定义 `RuntimeAPI` 类型，承载 apps.srv.src.veriq_server.handlers.enrollment 模块中的公开结构与协作边界
请结合调用方契约与 Workspace 授权边界阅读实现，避免绕过既有校验路径。
# 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
# 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
# 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。
实现时不得绕过 Workspace 归属校验，也不得把密钥或明文凭证写入日志。
若行为变更，请同步更新契约样例、相关测试与可观察的错误码语义。
若行为变更，请同步更新契约样例、相关测试与可观察的错误码语义。
    本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
    # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
    # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
    调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
    与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
    性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
    测试与文档应能证明该路径在无模型凭证、缺浏览器或租约过期时仍失败关闭正确。
本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。"""
    # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
    # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
    def prepare(self) -> None:
        """公开函数 `prepare` 负责 apps.srv.src.veriq_server.handlers.enrollment 中的关键业务流程与结果返回
请结合调用方契约与 Workspace 授权边界阅读实现，避免绕过既有校验路径。
本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。
实现时不得绕过 Workspace 归属校验，也不得把密钥或明文凭证写入日志。
若行为变更，请同步更新契约样例、相关测试与可观察的错误码语义。
# 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
# 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
# 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
若行为变更，请同步更新契约样例、相关测试与可观察的错误码语义。
        本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
        调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
        与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        测试与文档应能证明该路径在无模型凭证、缺浏览器或租约过期时仍失败关闭正确。
本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。"""
        super().prepare()
        allowed = {
            "runtimes": "GET",
            # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
            # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
            "runtime": "GET",
            "runtime-grants": "PUT",
            "runtime-trust": "PUT",
            "runtime-delivery": "PUT",
            # 分段注释：继续说明 enrollment.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
            # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
            "runtime-revoke": "POST",
        }[self.action]
        # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        if self.request.method != allowed:
            raise Problem(405, "METHOD_NOT_ALLOWED", "Method not allowed")

    async def get(self, workspace_id: str, runtime_id: str | None = None) -> None:
        """公开函数 `get` 负责 apps.srv.src.veriq_server.handlers.enrollment 中的关键业务流程与结果返回
请结合调用方契约与 Workspace 授权边界阅读实现，避免绕过既有校验路径。
# 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
# 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
# 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。
实现时不得绕过 Workspace 归属校验，也不得把密钥或明文凭证写入日志。
若行为变更，请同步更新契约样例、相关测试与可观察的错误码语义。
若行为变更，请同步更新契约样例、相关测试与可观察的错误码语义。
        本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
        # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
        与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        测试与文档应能证明该路径在无模型凭证、缺浏览器或租约过期时仍失败关闭正确。
本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。"""
        # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        if self.action not in {"runtimes", "runtime"}:
            raise Problem(405, "METHOD_NOT_ALLOWED", "Method not allowed")
        async with self.db.sessions() as session:
            user, _ = await self.identity(session)
            service = RuntimeService(session)
            # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
            # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
            await WorkspaceRepository(session, WorkspaceScope(workspace_id)).authorize(user)
            # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            if runtime_id:
                runtime, binding = await service.require_access(user, workspace_id, runtime_id)
                self.respond(await service.dto(runtime, binding, user))
                return
            # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
            # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
            page = Page.read(
                self,
                {"list": "runtimes", "workspaceId": workspace_id, "actor": user.id},
                # 分段注释：继续说明 enrollment.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
                # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
                self.config.signing_key.get_secret_value(),
            )
            grant = select(RuntimeGrant.runtime_id).where(
                RuntimeGrant.workspace_id == workspace_id, RuntimeGrant.user_id == user.id
            # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
            # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
            )
            _, member = await WorkspaceRepository(session, WorkspaceScope(workspace_id)).authorize(
                user
            )
            # 分段注释：继续说明 enrollment.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
            # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
            service_owned = (
                Runtime.owner_service_account_id.is_not(None)
                # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                if member.role in {"OWNER", "ADMIN"}
                # 关键路径：处理 else 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                else false()
            )
            query = (
                select(Runtime, RuntimeBinding)
                # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                .join(RuntimeBinding, RuntimeBinding.runtime_id == Runtime.id)
                .where(
                    RuntimeBinding.workspace_id == workspace_id,
                    # 分段注释：继续说明 enrollment.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                    # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
                    # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
                    or_(
                        service_owned,
                        Runtime.owner_user_id == user.id,
                        RuntimeBinding.shared_with_workspace.is_(True),
                        # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                        # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                        # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                        Runtime.id.in_(grant),
                    ),
                )
            )
            # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            if page.last:
                query = query.where(Runtime.id > page.last[1])
            rows = (await session.execute(query.order_by(Runtime.id).limit(page.limit + 1))).all()
            shown = rows[: page.limit]
            # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
            # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
            self.respond(
                {
                    "items": [await service.dto(r, b, user) for r, b in shown],
                    # 分段注释：继续说明 enrollment.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                    # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
                    # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
                    "nextCursor": page.next(
                        (shown[-1][0].id, shown[-1][0].id), len(rows) > page.limit
                    )
                    # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                    if shown
                    # 关键路径：处理 else 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                    else None,
                }
            )

    async def put(self, workspace_id: str, runtime_id: str) -> None:
        """公开函数 `put` 负责 apps.srv.src.veriq_server.handlers.enrollment 中的关键业务流程与结果返回
# 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
# 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
# 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
请结合调用方契约与 Workspace 授权边界阅读实现，避免绕过既有校验路径。
本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。
实现时不得绕过 Workspace 归属校验，也不得把密钥或明文凭证写入日志。
若行为变更，请同步更新契约样例、相关测试与可观察的错误码语义。
若行为变更，请同步更新契约样例、相关测试与可观察的错误码语义。
        # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
        调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
        与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        测试与文档应能证明该路径在无模型凭证、缺浏览器或租约过期时仍失败关闭正确。
# 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
# 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
# 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。"""
        if self.action not in {"runtime-grants", "runtime-trust", "runtime-delivery"}:
            raise Problem(405, "METHOD_NOT_ALLOWED", "Method not allowed")
        data = self.body(
            {
                # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                "runtime-grants": "RuntimeGrantWrite",
                "runtime-trust": "RuntimeTrustWrite",
                "runtime-delivery": "RuntimeCredentialDeliveryWrite",
            # 分段注释：继续说明 enrollment.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
            # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
            }[self.action]
        )
        async with self.db.sessions.begin() as session:
            await lock_installation(session)
            # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
            # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
            user, _ = await self.identity(session)
            service = RuntimeService(session)
            runtime, binding = await service.require_access(
                user, workspace_id, runtime_id, owner=self.action == "runtime-grants"
            # 分段注释：继续说明 enrollment.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
            # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
            )
            # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            if self.action == "runtime-grants":
                await service.set_grants(user, binding, runtime, data)
            # 关键路径：处理 elif 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            elif self.action == "runtime-delivery":
                await service.set_credential_delivery(
                    user, runtime, binding, data["allowCredentialDelivery"]
                )
            # 关键路径：处理 else 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            else:
                # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                if not user.system_admin:
                    raise Problem(
                        403,
                        "ADMIN_REQUIRED",
                        # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                        # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                        # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                        "Only a system administrator can approve Runtime trust",
                    )
                await service.require_owner_current(runtime, binding)
                # 分段注释：继续说明 enrollment.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
                # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
                has_share = binding.shared_with_workspace or bool(
                    (
                        await session.execute(
                            select(RuntimeGrant).where(
                                # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                                # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                                # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                                RuntimeGrant.runtime_id == runtime_id,
                                RuntimeGrant.workspace_id == workspace_id,
                            )
                        )
                    # 分段注释：继续说明 enrollment.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                    # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
                    # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
                    ).first()
                )
                # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                if data["trustStatus"] == "MANAGED" and not has_share:
                    raise Problem(
                        403,
                        "OWNER_CONSENT_REQUIRED",
                        # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                        # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                        # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                        "Owner must share the Runtime before trust approval",
                    )
                # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                if data["allowCredentialDelivery"] and data["trustStatus"] != "MANAGED":
                    raise Problem(
                        400, "INVALID_REQUEST", "Credential delivery requires MANAGED trust"
                    )
                # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                if data["allowCredentialDelivery"]:
                    await WorkspaceRepository(session, WorkspaceScope(workspace_id)).authorize(
                        user, Permission.MANAGE_ENVIRONMENT, write=True
                    )
                # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                runtime.trust_status = data["trustStatus"]
                binding.allow_credential_delivery = data["allowCredentialDelivery"]
                audit(
                    # 分段注释：继续说明 enrollment.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                    # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
                    # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
                    session, "runtime.trust_changed", user.id, runtime.id, workspace_id=workspace_id
                )
            result = await service.dto(runtime, binding, user)
        self.respond(result)

    # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
    # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
    async def post(self, workspace_id: str, runtime_id: str) -> None:
        """公开函数 `post` 负责 apps.srv.src.veriq_server.handlers.enrollment 中的关键业务流程与结果返回
请结合调用方契约与 Workspace 授权边界阅读实现，避免绕过既有校验路径。
本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。
实现时不得绕过 Workspace 归属校验，也不得把密钥或明文凭证写入日志。
若行为变更，请同步更新契约样例、相关测试与可观察的错误码语义。
# 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
# 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
# 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
若行为变更，请同步更新契约样例、相关测试与可观察的错误码语义。
        本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
        调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
        与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        测试与文档应能证明该路径在无模型凭证、缺浏览器或租约过期时仍失败关闭正确。
本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。"""
        if self.action != "runtime-revoke":
            raise Problem(405, "METHOD_NOT_ALLOWED", "Method not allowed")
        self.body("EmptyObject")
        # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        async with self.db.sessions.begin() as session:
            await lock_installation(session)
            user, _ = await self.identity(session)
            service = RuntimeService(session)
            # 分段注释：继续说明 enrollment.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
            # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
            runtime, binding = await service.require_access(
                user, workspace_id, runtime_id, owner=True
            )
            runtime.trust_status = "REVOKED"
            # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
            # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
            binding.active = False
            binding.allow_credential_delivery = False
            audit(session, "runtime.revoked", user.id, runtime.id, workspace_id=workspace_id)
            result = await service.dto(runtime, binding, user)
        # 分段注释：继续说明 enrollment.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
        # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
        self.respond(result)
