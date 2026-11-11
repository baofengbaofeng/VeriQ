"""Storage contract tests use actual filesystem operations, never mocked CAS bytes."""

import importlib
import importlib.util
from hashlib import sha256
from uuid import uuid4
import pytest


async def test_file_cas_exact_bytes_replay_scope_integrity_and_delete(tmp_path):
    assert importlib.util.find_spec("veriq_server.services.artifact") is not None, (
        "Missing ArtifactStore implementation"
    )
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


async def test_s3_real_loopback_http_exact_bytes_conditional_replay_and_delete(monkeypatch):
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
    finally:
        server.stop()
