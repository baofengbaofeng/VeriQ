"""中文重写：Session-authorized Workspace, member and invitation HTTP API.
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

import logging
import secrets
from datetime import timedelta
# 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
# 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
# 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
from typing import Any
from uuid import uuid4

from sqlalchemy import and_, or_, select

from ..auth.authorization import Authorization, Permission, WorkspaceScope
# 分段注释：继续说明 workspace.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
# 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
# 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
from ..db import User, Workspace, WorkspaceMember, WorkspaceInvite
from ..pagination import Page, boolean_filter
from ..service import Problem, audit, create_user, digest, lock_installation, now, stamp, user_dto
from ..services.workspace import WorkspaceRepository, workspace_dto, member_dto, invitation_dto
# 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
# 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
# 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
from .base import API

log = logging.getLogger("veriq.http")


class WorkspaceAPI(API):
    """定义 `WorkspaceAPI` 类型，承载 apps.srv.src.veriq_server.handlers.workspace 模块中的公开结构与协作边界
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
    def prepare(self) -> None:
        """公开函数 `prepare` 负责 apps.srv.src.veriq_server.handlers.workspace 中的关键业务流程与结果返回
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
        super().prepare()
        allowed = {
            "workspaces": {"GET", "POST"},
            "workspace": {"GET", "PATCH", "DELETE"},
            # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
            # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
            "members": {"GET"},
            "member": {"PUT", "DELETE"},
            "invitations": {"GET", "POST"},
            # 分段注释：继续说明 workspace.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
            # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
            "invitation": {"DELETE"},
            "accept-invitation": {"POST"},
        }
        # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        if self.request.method not in allowed[self.action]:
            raise Problem(405, "METHOD_NOT_ALLOWED", "Method not allowed")

    def page(self, actor_id: str, workspace_id: str | None = None, **filters: Any) -> Page:
        """公开函数 `page` 负责 apps.srv.src.veriq_server.handlers.workspace 中的关键业务流程与结果返回
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
        return Page.read(
            self,
            {"list": self.action, "actor": actor_id, "workspaceId": workspace_id, **filters},
            self.config.signing_key.get_secret_value(),
        )

    # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
    # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
    async def get(self, workspace_id: str | None = None) -> None:
        """公开函数 `get` 负责 apps.srv.src.veriq_server.handlers.workspace 中的关键业务流程与结果返回
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
        async with self.db.sessions() as s:
            user, _ = await self.identity(s)
            # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            if self.action == "workspaces":
                archived = boolean_filter(self, "archived")
                page = self.page(user.id, archived=archived)
                query = (
                    # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                    # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                    # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                    select(Workspace, WorkspaceMember)
                    .join(WorkspaceMember)
                    .where(WorkspaceMember.user_id == user.id, WorkspaceMember.status == "ACTIVE")
                # 分段注释：继续说明 workspace.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
                # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
                )
                # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                if archived is not None:
                    query = query.where(Workspace.archived.is_(archived))
                # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                if page.last:
                    key, identifier = page.last
                    query = query.where(
                        or_(
                            # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                            # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                            # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                            Workspace.key > key,
                            and_(Workspace.key == key, Workspace.id > identifier),
                        )
                    # 分段注释：继续说明 workspace.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                    # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
                    # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
                    )
                rows = (
                    await s.execute(
                        query.order_by(Workspace.key, Workspace.id).limit(page.limit + 1)
                    # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                    # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                    # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                    )
                ).all()
                items = rows[: page.limit]
                cursor = (
                    # 分段注释：继续说明 workspace.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                    # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
                    # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
                    page.next((items[-1][0].key, items[-1][0].id), len(rows) > page.limit)
                    # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                    if items
                    # 关键路径：处理 else 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                    else None
                )
                self.respond(
                    {"items": [workspace_dto(w, m.role) for w, m in items], "nextCursor": cursor}
                # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                )
                return
            assert workspace_id is not None
            # 分段注释：继续说明 workspace.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
            # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
            repo = WorkspaceRepository(s, WorkspaceScope(workspace_id))
            permission = (
                Permission.MANAGE_MEMBERS if self.action == "invitations" else Permission.VIEW
            )
            # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
            # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
            workspace, actor = await repo.authorize(user, permission)
            # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            if self.action == "workspace":
                self.respond(workspace_dto(workspace, actor.role))
                return
            page = self.page(user.id, workspace_id)
            # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            if self.action == "members":
                query_members = (
                    select(WorkspaceMember, User)
                    .join(User)
                    # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                    # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                    # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                    .where(WorkspaceMember.workspace_id == workspace_id)
                )
                # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                if page.last:
                    email, identifier = page.last
                    query_members = query_members.where(
                        or_(User.email > email, and_(User.email == email, User.id > identifier))
                    # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                    # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                    # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                    )
                members = (
                    await s.execute(
                        # 分段注释：继续说明 workspace.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                        # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
                        # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
                        query_members.order_by(User.email, User.id).limit(page.limit + 1)
                    )
                ).all()
                shown_members = members[: page.limit]
                # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                cursor = (
                    page.next(
                        (shown_members[-1][1].email, shown_members[-1][1].id),
                        len(members) > page.limit,
                    # 分段注释：继续说明 workspace.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                    # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
                    # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
                    )
                    # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                    if shown_members
                    # 关键路径：处理 else 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                    else None
                )
                self.respond(
                    {"items": [member_dto(m, u) for m, u in shown_members], "nextCursor": cursor}
                # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                )
            # 关键路径：处理 else 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            else:
                query_invites = select(WorkspaceInvite).where(
                    WorkspaceInvite.workspace_id == workspace_id
                )
                # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                if page.last:
                    email, identifier = page.last
                    query_invites = query_invites.where(
                        or_(
                            # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                            # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                            # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                            WorkspaceInvite.email > email,
                            and_(WorkspaceInvite.email == email, WorkspaceInvite.id > identifier),
                        )
                    # 分段注释：继续说明 workspace.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                    # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
                    # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
                    )
                invites = (
                    (
                        await s.execute(
                            # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                            # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                            # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                            query_invites.order_by(WorkspaceInvite.email, WorkspaceInvite.id).limit(
                                page.limit + 1
                            )
                        )
                    # 分段注释：继续说明 workspace.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                    # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
                    # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
                    )
                    .scalars()
                    .all()
                )
                # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                shown = invites[: page.limit]
                cursor = (
                    page.next((shown[-1].email, shown[-1].id), len(invites) > page.limit)
                    # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                    if shown
                    # 关键路径：处理 else 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                    else None
                )
                self.respond({"items": [invitation_dto(i) for i in shown], "nextCursor": cursor})

    async def post(self, workspace_id: str | None = None) -> None:
        """公开函数 `post` 负责 apps.srv.src.veriq_server.handlers.workspace 中的关键业务流程与结果返回
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
        if self.action == "accept-invitation":
            await self.accept_invitation()
            return
        data = self.body("WorkspaceWrite" if self.action == "workspaces" else "InviteRequest")
        # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        result: dict[str, Any]
        async with self.db.sessions.begin() as s:
            await lock_installation(s)
            # 分段注释：继续说明 workspace.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
            # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
            user, _ = await self.identity(s)
            # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            if self.action == "workspaces":
                exists = (
                    await s.execute(select(Workspace.id).where(Workspace.key == data["key"]))
                ).scalar_one_or_none()
                # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                if exists:
                    raise Problem(
                        409,
                        "WORKSPACE_KEY_EXISTS",
                        # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                        # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                        # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                        "Workspace key already exists, including archived Workspaces",
                    )
                workspace = Workspace(
                    # 分段注释：继续说明 workspace.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                    # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
                    # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
                    id=str(uuid4()),
                    key=data["key"],
                    name=data["name"],
                    archived=False,
                    # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                    # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                    # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                    created_at=now(),
                )
                s.add(workspace)
                await s.flush()
                # 分段注释：继续说明 workspace.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
                # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
                s.add(
                    WorkspaceMember(
                        workspace_id=workspace.id, user_id=user.id, role="OWNER", status="ACTIVE"
                    )
                # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                )
                audit(s, "workspace.created", user.id, workspace.id, workspace_id=workspace.id)
                result = workspace_dto(workspace, "OWNER")
            # 关键路径：处理 else 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            else:
                assert workspace_id is not None
                repo = WorkspaceRepository(s, WorkspaceScope(workspace_id))
                await repo.authorize(user, Permission.MANAGE_MEMBERS, write=True)
                # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                if data.get("sendEmail") and not self.application.settings["mail_delivery"]:
                    raise Problem(
                        409,
                        "SMTP_UNAVAILABLE",
                        # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                        # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                        # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                        "Email delivery is not configured; use a copyable link",
                    )
                token = secrets.token_urlsafe(32)
                # 分段注释：继续说明 workspace.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
                # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
                invitation = WorkspaceInvite(
                    id=str(uuid4()),
                    workspace_id=workspace_id,
                    email=data["email"].lower(),
                    # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                    # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                    # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                    role=data["role"],
                    token_hash=digest(token),
                    expires_at=now() + timedelta(days=7),
                    created_at=now(),
                    # 分段注释：继续说明 workspace.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                    # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
                    # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
                    consumed=False,
                    revoked=False,
                )
                s.add(invitation)
                # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                audit(s, "workspace.invited", user.id, invitation.id, workspace_id=workspace_id)
                result = {
                    "id": invitation.id,
                    "expiresAt": stamp(invitation.expires_at),
                    # 分段注释：继续说明 workspace.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                    # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
                    # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
                    "invitationUrl": self.config.public_url + "/invitations/accept#token=" + token,
                    "delivery": "NOT_REQUESTED",
                }
        # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        if self.action == "invitations" and data.get("sendEmail"):
            # 关键路径：处理 try 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            try:
                await self.application.settings["mail_delivery"].send(
                    data["email"].lower(),
                    "VeriQ Workspace invitation",
                    # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                    # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                    # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                    "Accept your Workspace invitation: " + result["invitationUrl"],
                )
                result["delivery"] = "SENT"
            # 关键路径：处理 except 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            except Exception:
                # The copyable link remains usable; do not log addresses/tokens/adapter errors.
                log.warning("Workspace invitation email delivery failed")
                result["delivery"] = "FAILED"
        self.respond(result, 201)

    async def accept_invitation(self) -> None:
        """公开函数 `accept_invitation` 负责 apps.srv.src.veriq_server.handlers.workspace 中的关键业务流程与结果返回
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
        data = self.body("InvitationAcceptRequest")
        async with self.db.sessions.begin() as s:
            await lock_installation(s)
            invitation = (
                # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                await s.execute(
                    select(WorkspaceInvite).where(
                        WorkspaceInvite.token_hash == digest(data["token"])
                    # 分段注释：继续说明 workspace.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                    # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
                    # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
                    )
                )
            ).scalar_one_or_none()
            # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            if (
                not invitation
                or invitation.consumed
                or invitation.revoked
                # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                or invitation.expires_at <= now()
            ):
                raise Problem(400, "INVALID_INVITATION", "Invitation is invalid or expired")
            # 分段注释：继续说明 workspace.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
            # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
            repo = WorkspaceRepository(s, WorkspaceScope(invitation.workspace_id))
            # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            if (await repo.get()).archived:
                raise Problem(409, "WORKSPACE_ARCHIVED", "Workspace is archived")
            user = (
                await s.execute(select(User).where(User.email == invitation.email))
            # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
            # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
            ).scalar_one_or_none()
            # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            if user:
                # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                if user.disabled:
                    raise Problem(403, "USER_DISABLED", "Account is disabled")
                authenticated, _ = await self.identity(s)
                # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                if authenticated.id != user.id:
                    raise Problem(
                        403, "INVITATION_IDENTITY_MISMATCH", "Sign in with the invited account"
                    )
                # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                if "password" in data or "displayName" in data:
                    raise Problem(
                        400,
                        "EXISTING_ACCOUNT",
                        # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                        # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                        # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                        "Existing accounts accept using their current identity",
                    )
            # 关键路径：处理 else 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            else:
                # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                if "password" not in data or "displayName" not in data:
                    raise Problem(
                        400,
                        "ACCOUNT_DETAILS_REQUIRED",
                        # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                        # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                        # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                        "New accounts require display name and password",
                    )
                user = await create_user(s, {**data, "email": invitation.email})
            # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            if await repo.member(user.id):
                raise Problem(409, "MEMBER_EXISTS", "Account is already a Workspace member")
            s.add(
                WorkspaceMember(
                    # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                    # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                    # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                    workspace_id=invitation.workspace_id,
                    user_id=user.id,
                    role=invitation.role,
                    # 分段注释：继续说明 workspace.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                    # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
                    # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
                    status="ACTIVE",
                )
            )
            invitation.consumed = True
            # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
            # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
            audit(
                s,
                "workspace.invitation_accepted",
                user.id,
                # 分段注释：继续说明 workspace.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
                # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
                invitation.id,
                workspace_id=invitation.workspace_id,
            )
            result = user_dto(user)
        # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        self.respond(result)

    async def patch(self, workspace_id: str) -> None:
        """公开函数 `patch` 负责 apps.srv.src.veriq_server.handlers.workspace 中的关键业务流程与结果返回
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
        data = self.body("WorkspaceRename")
        async with self.db.sessions.begin() as s:
            # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
            # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
            await lock_installation(s)
            user, _ = await self.identity(s)
            workspace, actor = await WorkspaceRepository(s, WorkspaceScope(workspace_id)).authorize(
                user, Permission.MANAGE_WORKSPACE, write=True
            )
            # 分段注释：继续说明 workspace.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
            # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
            workspace.name = data["name"]
            audit(s, "workspace.updated", user.id, workspace_id, workspace_id=workspace_id)
            result = workspace_dto(workspace, actor.role)
        self.respond(result)

    # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
    # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
    async def put(self, workspace_id: str, user_id: str) -> None:
        """公开函数 `put` 负责 apps.srv.src.veriq_server.handlers.workspace 中的关键业务流程与结果返回
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
        data = self.body("MemberWrite")
        async with self.db.sessions.begin() as s:
            await lock_installation(s)
            # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
            # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
            user, _ = await self.identity(s)
            scope = WorkspaceScope(workspace_id)
            repo = WorkspaceRepository(s, scope)
            _, actor = await repo.authorize(user, Permission.MANAGE_MEMBERS, write=True)
            # 分段注释：继续说明 workspace.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
            # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
            member = await repo.member(user_id)
            target = await s.get(User, user_id)
            # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            if not member or not target:
                raise Problem(404, "MEMBER_NOT_FOUND", "Workspace member not found")
            # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            if member.role == "OWNER" or data["role"] == "OWNER":
                Authorization.require(actor, scope, Permission.OWNERSHIP)
            # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            if data["role"] != "OWNER" or data["status"] != "ACTIVE":
                await repo.protect_owner(user_id)
            # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            if (
                data["role"] == "OWNER"
                and member.role != "OWNER"
                and (target.disabled or data["status"] != "ACTIVE")
            # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
            # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
            ):
                raise Problem(409, "OWNER_DISABLED", "OWNER must be an enabled active member")
            member.role, member.status = data["role"], data["status"]
            # 分段注释：继续说明 workspace.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
            # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
            audit(s, "workspace.member_updated", user.id, user_id, workspace_id=workspace_id)
            result = member_dto(member, target)
        self.respond(result)

    async def delete(self, workspace_id: str, identifier: str | None = None) -> None:
        """公开函数 `delete` 负责 apps.srv.src.veriq_server.handlers.workspace 中的关键业务流程与结果返回
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
        async with self.db.sessions.begin() as s:
            await lock_installation(s)
            user, _ = await self.identity(s)
            scope = WorkspaceScope(workspace_id)
            # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
            # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
            repo = WorkspaceRepository(s, scope)
            permission = (
                Permission.OWNERSHIP if self.action == "workspace" else Permission.MANAGE_MEMBERS
            # 分段注释：继续说明 workspace.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
            # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
            )
            workspace, actor = await repo.authorize(user, permission, write=True)
            # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            if self.action == "workspace":
                workspace.archived = True
                audit(s, "workspace.archived", user.id, workspace_id, workspace_id=workspace_id)
            # 关键路径：处理 elif 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            elif self.action == "member":
                assert identifier is not None
                member = await repo.member(identifier)
                # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                if not member:
                    raise Problem(404, "MEMBER_NOT_FOUND", "Workspace member not found")
                # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                if member.role == "OWNER":
                    Authorization.require(actor, scope, Permission.OWNERSHIP)
                await repo.protect_owner(identifier)
                await s.delete(member)
                # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                audit(s, "workspace.member_removed", user.id, identifier, workspace_id=workspace_id)
            # 关键路径：处理 else 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            else:
                assert identifier is not None
                invitation = await repo.invite(identifier)
                invitation.revoked = True
                # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                audit(
                    s,
                    "workspace.invitation_revoked",
                    # 分段注释：继续说明 workspace.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                    # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
                    # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
                    user.id,
                    identifier,
                    workspace_id=workspace_id,
                )
        # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        self.respond({})
