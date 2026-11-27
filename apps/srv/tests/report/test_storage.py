import importlib
import importlib.util
from hashlib import sha256
from uuid import uuid4
import pytest
from test_auth import login, setup
from test_workspace import workspace as create_workspace
from veriq_server.db import Artifact, ArtifactDeletion
from veriq_server.file_volume import check_volume
from veriq_server.service import Problem, lock_installation, now
from veriq_server.services.artifact import FileArtifactStore, bind_volume


async def test_file_cas_exact_bytes_replay_scope_integrity_and_delete(tmp_path):
    spec = importlib.util.find_spec("veriq_server.services.artifact")
    assert spec is not None, "Missing ArtifactStore implementation"
    store = importlib.import_module("veriq_server.services.artifact").FileArtifactStore(tmp_path)
    workspace = str(uuid4())
    data = b"raw\x00credential-restricted\xffevidence"
    digest = sha256(data).hexdigest()
    await store.put(workspace, digest, data)
    await store.put(workspace, digest, data)
    assert await store.read(workspace, digest, len(data)) == data
    with pytest.raises(FileNotFoundError):
        await store.read(str(uuid4()), digest, len(data))
    with pytest.raises(ValueError):
        await store.put(workspace, digest, b"changed")
    with pytest.raises(ValueError):
        await store.read("../outside", digest, len(data))
    with pytest.raises(ValueError):
        await store.read(workspace, digest, len(data) + 1)
    await store.delete(workspace, digest)
    await store.delete(workspace, digest)
    with pytest.raises(FileNotFoundError):
        await store.read(workspace, digest, len(data))


async def test_s3_real_loopback_http_exact_bytes_conditional_replay_and_delete(monkeypatch, caplog):
    from moto.server import ThreadedMotoServer
    from veriq_server.services.artifact import S3ArtifactStore
    import asyncio
    from botocore.exceptions import ClientError

    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "synthetic-test")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "synthetic-test")
    monkeypatch.setenv("AWS_EC2_METADATA_DISABLED", "true")
    server = ThreadedMotoServer(ip_address="127.0.0.1", port=0, verbose=False)
    server.start()
    host, port = server.get_host_and_port()
    try:
        store = S3ArtifactStore("veriq-test", f"http://{host}:{port}")
        await asyncio.to_thread(store.client.create_bucket, Bucket="veriq-test")
        workspace = str(uuid4())
        data = b"real-http-private-evidence"
        digest = sha256(data).hexdigest()
        await store.put(workspace, digest, data)
        await store.put(workspace, digest, data)
        assert await store.read(workspace, digest, len(data)) == data
        with pytest.raises(ValueError):
            await store.put(workspace, digest, b"changed")
        with pytest.raises(ClientError):
            await store.read(str(uuid4()), digest, len(data))
        old_incarnation, new_incarnation = str(uuid4()), str(uuid4())
        await store.put(workspace, digest, data, old_incarnation)
        await store.put(workspace, digest, data, new_incarnation)
        await store.delete(workspace, digest, old_incarnation)
        assert await store.read(workspace, digest, len(data), new_incarnation) == data
        await store.delete(workspace, digest, new_incarnation)
        await store.delete(workspace, digest)
        await store.delete(workspace, digest)
        with pytest.raises(ClientError):
            await store.read(workspace, digest, len(data))
        records = [r for r in caplog.records if getattr(r, "veriq_tag", "") == "_com_http_failure"]
        assert [record.veriq_fields["errno"] for record in records] == [412, 404, 404]
        results = [r.veriq_fields for r in caplog.records if hasattr(r, "veriq_fields")]
        assert all(digest not in repr(fields) for fields in results)
    finally:
        server.stop()


async def test_registered_volume_is_shared_and_independent_root_cannot_retire(site, tmp_path):
    """共享数据库中的第二个节点只有挂载原卷才能下载与退役同代证据，错挂空卷必须在物理写入前失败。"""
    _, db = site
    shared = tmp_path / "shared"
    independent = tmp_path / "node-b"
    independent.mkdir()

    async def connect(root):
        async with db.sessions.begin() as session:
            installation = await lock_installation(session)
            identity = await bind_volume(session, installation, root)
            return FileArtifactStore(root, identity)

    a = await connect(shared)
    workspace, incarnation = str(uuid4()), str(uuid4())
    content = b"cross-node evidence"
    digest = sha256(content).hexdigest()
    await a.put(workspace, digest, content, incarnation)
    b = await connect(independent)
    with pytest.raises(Problem, match="Mount the registered"):
        check_volume(independent, b.volume_id)
    with pytest.raises(Problem):
        await b.retire(workspace, digest, incarnation)
    assert not list(independent.iterdir())
    b = await connect(shared)
    assert await b.read(workspace, digest, len(content), incarnation) == content
    await b.retire(workspace, digest, incarnation)
    with pytest.raises(ValueError):
        await a.read(workspace, digest, len(content), incarnation)


async def test_upgrade_verifies_legacy_bytes_and_retired_generation_before_binding(site, tmp_path):
    """用保留原始键的旧制品和已退役的代际验证升级，绑定只有在原字节和空屏障各自核验成功后才生效。"""
    client, db = site
    await setup(client)
    await login(client)
    tenant = await create_workspace(client)
    live = b"evidence predating volume registration"
    digest = sha256(live).hexdigest()
    retired_id = str(uuid4())
    store = FileArtifactStore(tmp_path)
    async with db.sessions.begin() as session:
        session.add(
            Artifact(
                workspace_id=tenant,
                sha256=digest,
                size_bytes=len(live),
                media_type="application/octet-stream",
                storage_backend="FILE",
            )
        )
        session.add(
            ArtifactDeletion(
                id=str(uuid4()),
                workspace_id=tenant,
                sha256=digest,
                storage_backend="FILE",
                storage_incarnation=retired_id,
                deleted_at=now(),
            )
        )

    async def bind(adopt=False):
        async with db.sessions.begin() as session:
            installation = await lock_installation(session)
            return await bind_volume(session, installation, tmp_path, adopt=adopt)

    with pytest.raises(Problem) as blocked:
        await bind()
    assert blocked.value.code == "ARTIFACT_VOLUME_UNBOUND"
    with pytest.raises(FileNotFoundError):
        await bind(adopt=True)
    await store.put(tenant, digest, live)
    with pytest.raises(ValueError, match="retired artifact barrier"):
        await bind(adopt=True)
    assert not (tmp_path / ".veriq-volume").exists()

    await store.retire(tenant, digest, retired_id)
    bound = await bind(adopt=True)
    assert await bind() == bound
    assert (tmp_path / ".veriq-volume").read_text() == bound
