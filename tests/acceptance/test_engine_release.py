"""引擎发行测试分别验证新快照选择与旧版本不变，以及操作员晋升的不可变身份约束；使用合成签发者和真实文件字节，不访问正式密钥，也不把测试库存声明为生产批准发行。

数据库之外的快照输入没有依赖引用，因此不需要模拟 SQL 结果。
晋升使用真实异步权威锁和原子文件替换。
"""

from hashlib import sha256
import json
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import pytest

from veriq_server.auth.authorization import WorkspaceScope
from veriq_server.services.resource import ResourceService
from veriq_server.settings import Settings


async def test_new_engine_selection_changes_source_hash_without_mutating_old_snapshot() -> None:
    """新选择只影响随后冻结的快照和 sourceHash，默认仍保留旧开发引擎版本；此前返回的快照字节保持原样，因此旧签名包、Job 和发布回执不会随服务配置改变而被重新解释。

    无依赖目录资产让测试聚焦实际 snapshot 逻辑。
    两次冻结使用相同资源、修订和文档，唯一变化是引擎选择。
    """
    resource = SimpleNamespace(id=str(uuid4()), kind="ELEMENT_CATALOG")
    draft = SimpleNamespace(
        revision=1,
        document_json={
            "kind": "ELEMENT_CATALOG",
            "document": {
                "schemaVersion": "1.0",
                "elements": [{"key": "save", "locator": {"by": "testId", "value": "save"}}],
            },
        },
    )
    scope = WorkspaceScope(str(uuid4()))
    previous = await ResourceService(None, None).snapshot(scope, resource, draft)
    frozen = json.dumps(previous, sort_keys=True)
    current = await ResourceService(None, None, engine_version="1.0.0").snapshot(
        scope, resource, draft
    )
    assert previous["engineVersion"] == "0.1.0"
    assert current["engineVersion"] == "1.0.0"
    assert current["sourceHash"] != previous["sourceHash"]
    assert json.dumps(previous, sort_keys=True) == frozen


@pytest.fixture
def promotion(tmp_path: Path):
    """操作员晋升应将新版本加入已有批准清单，而同版本不同字节必须拒绝并保留原文件；真实合成签发者使测试走与并发 Bundle 导出相同的 issuer 和 inventory 锁协议。

    四个候选文件的长度和摘要由实际字节计算。
    初始空库存表示尚未批准任何发行，不需要虚构旧批准记录。
    """
    from veriq_server.bundles.issuer import Issuer

    issuer = tmp_path / "issuer/issuer.json"
    issuer.parent.mkdir()
    Issuer.initialize(issuer)
    approved = tmp_path / "approved.json"
    approved.write_text('{"schemaVersion":"1.0","engines":[]}')
    settings = Settings(
        database_url="mysql+asyncmy://unused:unused@localhost/veriq_unused",
        public_url="https://veriq.example",
        master_key="a" * 64,
        signing_key="b" * 64,
        bundle_issuer_path=str(issuer),
        approved_engine_inventory_path=str(approved),
    )
    candidate = tmp_path / "candidate"
    candidate.mkdir()
    entries = []
    for name in [
        "package.json",
        "package-lock.json",
        "dependencies.json",
        "engine/compiler.tgz",
    ]:
        path = candidate / name
        path.parent.mkdir(exist_ok=True)
        path.write_bytes(b"test-only")
        entries.append({"path": name, "sha256": sha256(b"test-only").hexdigest(), "sizeBytes": 9})
    engine = {
        "engineVersion": "0.1.0",
        "compilerVersion": "0.1.0",
        "runnerSdkVersion": "0.1.0",
        "dependencies": [],
        "files": entries,
    }
    inventory = candidate / "inventory.json"
    inventory.write_text(json.dumps({"schemaVersion": "1.0", "engines": [engine]}))
    return settings, candidate, engine, approved


async def test_promotion_retains_old_version_and_rejects_same_version_different_bytes(
    promotion,
) -> None:
    """操作员新增版本时保留旧批准条目，重复版本只有完全相同的规范字节才允许幂等成功；改变编译器身份即使文件摘要未变也必须拒绝，防止历史回执被重新解释为不同发行。

    两次成功晋升分别建立旧版本与新候选版本。
    冲突失败后直接比较批准文件字节，确认没有部分写入。
    """
    from veriq_server.promote_engine import promote_engine

    settings, candidate, engine, approved = promotion
    inventory = candidate / "inventory.json"
    await promote_engine(settings, candidate)
    engine["engineVersion"] = "1.0.0"
    inventory.write_text(json.dumps({"schemaVersion": "1.0", "engines": [engine]}))
    await promote_engine(settings, candidate)
    before = approved.read_bytes()
    assert [item["engineVersion"] for item in json.loads(before)["engines"]] == [
        "0.1.0",
        "1.0.0",
    ]
    engine["compilerVersion"] = "9.0.0"
    inventory.write_text(json.dumps({"schemaVersion": "1.0", "engines": [engine]}))
    with pytest.raises(ValueError, match="immutable"):
        await promote_engine(settings, candidate)
    assert approved.read_bytes() == before


async def test_promotion_waits_for_issuer_guard_and_cancellation_keeps_inventory(
    promotion, monkeypatch
) -> None:
    """真实操作员锁阻塞晋升时取消任务必须保留原库存并释放稍后打开的文件描述符，随后新的晋升仍能完成；观察器只记录真实 open_lock 调用，不替代 flock 或伪造等待结果。

    外部描述符模拟同时进行的签发者维护。
    事件握手确认被测任务确实进入权威锁路径。
    取消不会留下一个稍后继续执行的后台库存替换。
    """
    import asyncio
    import fcntl
    import os
    from veriq_server.bundles import authority
    from veriq_server.promote_engine import promote_engine

    settings, candidate, _, approved = promotion
    before = approved.read_bytes()
    path = Path(settings.bundle_issuer_path).with_suffix(".lock")
    descriptor = authority.open_lock(path)
    fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    opened = asyncio.Event()
    loop = asyncio.get_running_loop()
    original = authority.open_lock

    def observed(value):
        result = original(value)
        loop.call_soon_threadsafe(opened.set)
        return result

    monkeypatch.setattr(authority, "open_lock", observed)
    task = asyncio.create_task(promote_engine(settings, candidate))
    try:
        await asyncio.wait_for(opened.wait(), 2)
        assert not task.done()
        assert approved.read_bytes() == before
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    finally:
        os.close(descriptor)
    monkeypatch.setattr(authority, "open_lock", original)
    await promote_engine(settings, candidate)
    assert len(json.loads(approved.read_bytes())["engines"]) == 1
