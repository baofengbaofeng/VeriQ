
import asyncio
import fcntl
import os
import threading
from veriq_server.bundles.authority import authority_guard
from veriq_server.bundles.issuer import Issuer
from veriq_server.settings import Settings


async def test_cancelled_guard_open_releases_eventual_descriptor(tmp_path, monkeypatch):
    import veriq_server.bundles.authority as authority

    path = tmp_path / "guard/keys.json"
    Issuer.initialize(path)
    settings = Settings(
        environment="development",
        database_url="mysql+asyncmy://unused/unused",
        public_url="http://localhost",
        master_key="a" * 64,
        signing_key="b" * 64,
        bundle_issuer_path=str(path),
    )
    started, finish = threading.Event(), threading.Event()
    original = authority.open_lock
    closed = asyncio.Event()
    captured: list[int] = []
    original_close = os.close

    def observe_close(fd):
        original_close(fd)
        if fd in captured:
            closed.set()

    monkeypatch.setattr(authority.os, "close", observe_close)

    def delayed(lock_path):
        fd = original(lock_path)
        captured.append(fd)
        started.set()
        assert finish.wait(5)
        return fd

    monkeypatch.setattr(authority, "open_lock", delayed)

    async def enter():
        async with authority_guard(settings, True):
            raise AssertionError("Cancelled acquisition must never enter")

    task = asyncio.create_task(enter())
    assert await asyncio.to_thread(started.wait, 5)
    task.cancel()
    finish.set()
    try:
        await task
    except asyncio.CancelledError:
        pass
    else:
        raise AssertionError("Expected cancellation")
    await asyncio.wait_for(closed.wait(), 5)
    fd = os.open(path.with_suffix(".lock"), os.O_RDWR)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    finally:
        os.close(fd)
