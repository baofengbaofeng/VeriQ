"""Cross-process configuration guard. Acquire before DB locks; never while holding them."""

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
    fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    if not stat.S_ISREG(os.fstat(fd).st_mode):
        os.close(fd)
        raise Problem(503, "BUNDLE_CONFIGURATION_UNAVAILABLE", "Unsafe configuration lock")
    return fd


def load(settings: Settings, draft: bool) -> tuple[Issuer, ApprovedEngines]:
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
    if not settings.bundle_issuer_path:
        raise Problem(503, "ISSUER_UNAVAILABLE", "Operator bundle issuer is unavailable")
    # Same stable issuer lock used by rotate/revoke. Configuration writers take
    # the private inventory lock before atomic replacement, always issuer then inventory.
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
                # The worker may finish opening after its caller is cancelled.
                # Its uncancelled result owns exactly one eventual close, even
                # if the caller receives another cancellation during cleanup.
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
