import asyncio
import fcntl
import os
import stat
from contextlib import asynccontextmanager
from collections.abc import AsyncIterator
from pathlib import Path
from ..service import Problem
from ..settings import Settings
from ..services.engines import ApprovedEngines
from .issuer import Issuer


def open_lock(path: Path) -> int:
    """以 O_NOFOLLOW 打开常规文件锁描述符，拒绝符号链接与非常规节点以防配置劫持；权限模式 0o600，配合 flock 实现跨进程权威配置互斥。
    open_lock 实现于 apps/srv/src/veriq_server/bundles/authority.py：请按该符号的输入校验、错误码与调用方契约阅读，勿假设通用成功默认值。
    """
    fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    if not stat.S_ISREG(os.fstat(fd).st_mode):
        os.close(fd)
        raise Problem(503, "BUNDLE_CONFIGURATION_UNAVAILABLE", "Unsafe configuration lock")
    return fd


def load(settings: Settings, draft: bool) -> tuple[Issuer, ApprovedEngines]:
    """在持锁线程中装载签发者与已批准引擎清单；draft 模式跳过生产清单文件读取；清单读取硬上限约 2MiB+1，超限由 ApprovedEngines 处理。
    load 实现于 apps/srv/src/veriq_server/bundles/authority.py：请按该符号的输入校验、错误码与调用方契约阅读，勿假设通用成功默认值。
    """
    issuer = Issuer(settings.bundle_issuer_path)
    raw = b""
    if not draft and settings.approved_engine_inventory_path:
        with open(settings.approved_engine_inventory_path, "rb") as stream:
            raw = stream.read(2 * 1024 * 1024 + 1)
    return issuer, ApprovedEngines(settings, raw)


@asynccontextmanager
async def authority_guard(
    settings: Settings, draft: bool
) -> AsyncIterator[tuple[Issuer, ApprovedEngines]]:
    """跨进程串行化 Bundle 权威配置：先持签发者锁再持清单锁，超时映射 CONFIGURATION_BUSY；取消时仍确保打开成功的 fd 被回调关闭，避免泄漏。
    authority_guard 实现于 apps/srv/src/veriq_server/bundles/authority.py：请按该符号的输入校验、错误码与调用方契约阅读，勿假设通用成功默认值。
    """
    if not settings.bundle_issuer_path:
        raise Problem(503, "ISSUER_UNAVAILABLE", "Operator bundle issuer is unavailable")
    # 与 rotate/revoke 共用稳定签发者锁；写配置时固定顺序：签发者锁 → 清单锁。
    paths = [Path(settings.bundle_issuer_path).with_suffix(".lock")]
    if not draft and settings.approved_engine_inventory_path:
        paths.append(Path(settings.bundle_issuer_path).with_suffix(".inventory.lock"))
    fds: list[int] = []
    try:
        for path in paths:
            opened = asyncio.create_task(asyncio.to_thread(open_lock, path))
            try:
                fd = await asyncio.shield(opened)
            except asyncio.CancelledError:
                # 取消后工作线程仍可能打开成功；由其未取消结果负责恰好一次 close。
                def discard(task: asyncio.Task[int]) -> None:
                    if not task.cancelled() and task.exception() is None:
                        os.close(task.result())

                opened.add_done_callback(discard)
                raise
            fds.append(fd)
            deadline = asyncio.get_running_loop().time() + 5
            while True:
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if asyncio.get_running_loop().time() >= deadline:
                        raise Problem(
                            409, "BUNDLE_CONFIGURATION_BUSY", "Configuration mutation in progress"
                        ) from None
                    await asyncio.sleep(0.025)
        yield await asyncio.to_thread(load, settings, draft)
    except OSError:
        raise Problem(
            503, "BUNDLE_CONFIGURATION_UNAVAILABLE", "Bundle configuration is unavailable"
        ) from None
    finally:
        for fd in reversed(fds):
            os.close(fd)
