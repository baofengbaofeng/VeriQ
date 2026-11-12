
import asyncio
import json
import os
import shutil
import tempfile
from hashlib import sha256
from pathlib import Path

import httpx
from test_auth import setup, login
from test_workspace import workspace, new_member, client
from test_lease_mysql import device
from test_agent_mysql import agent_once
from veriq_server.db import Artifact


async def test_published_source_exact_bytes_integrity_scope_and_current_membership(site):
    c, db = site
    await setup(c)
    await login(c)
    ws = await workspace(c)
    other_ws = await workspace(c, "other")
    created = await c.post(
        f"/api/v1/workspaces/{ws}/resources",
        json={
            "kind": "ELEMENT_CATALOG",
            "key": "catalog",
            "name": "Catalog",
            "content": {
                "kind": "ELEMENT_CATALOG",
                "document": {
                    "schemaVersion": "1.0",
                    "elements": [{"key": "name", "locator": {"by": "testId", "value": "name"}}],
                },
            },
        },
    )
    assert created.status_code == 201
    rid = created.json()["data"]["id"]
    base = f"/api/v1/workspaces/{ws}/resources/{rid}"
    preview = (await c.get(base + "/validation-preview")).json()["data"]
    queued = await c.post(
        base + "/validate",
        json={"revision": preview["revision"], "sourceHash": preview["sourceHash"]},
    )
    assert queued.status_code == 202
    job_id = queued.json()["data"]["id"]
    assert (
        await c.get(f"/api/v1/workspaces/{ws}/jobs/{job_id}/validation-receipt")
    ).status_code == 409
    # Real locked release packaging is test-only; controller never imports Node tooling.
    process = await asyncio.create_subprocess_exec(
        "node",
        "apps/web/tests/prepare-editor-agent.mjs",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    _, stderr = await process.communicate()
    assert process.returncode == 0, stderr.decode()
    release = Path(".superpowers/cache/t11/release").resolve()
    env = json.loads(Path(".superpowers/sdd/veriq-1/test-env.json").read_text())
    approved = Path(env["approved_engine_inventory_path"])
    previous = approved.read_bytes() if approved.exists() else None
    profile = Path(tempfile.mkdtemp(prefix="vq11-py-", dir="/tmp"))
    try:
        approved.write_bytes((release / "inventory.json").read_bytes())
        credential = await device(c, ws)
        runtime = f"/api/v1/workspaces/{ws}/runtimes/{credential['runnerId']}"
        assert (
            await c.put(
                runtime + "/grants",
                json={"workspaceId": ws, "userIds": [], "sharedWithWorkspace": True},
            )
        ).status_code == 200
        assert (
            await c.put(
                runtime + "/trust",
                json={"trustStatus": "MANAGED", "allowCredentialDelivery": False},
            )
        ).status_code == 200
        (profile / "device.json").write_text(
            json.dumps({"server": "http://127.0.0.1:18889", **credential})
        )
        os.chmod(profile / "device.json", 0o600)
        await agent_once(profile, release)
        status = (await c.get(f"/api/v1/workspaces/{ws}/jobs/{job_id}")).json()["data"]
        assert status["state"] == "FINISHED" and status["outcome"] == "PASSED"
        receipt = (await c.get(f"/api/v1/workspaces/{ws}/jobs/{job_id}/validation-receipt")).json()[
            "data"
        ]
        published = await c.post(
            base + "/publish",
            json={"revision": preview["revision"], "validationReceiptId": receipt["id"]},
        )
        assert published.status_code == 201
        vid = published.json()["data"]["id"]
        source = base + f"/versions/{vid}/compiled-source"
        metadata = (await c.get(source)).json()["data"]
        assert metadata["descriptorSha256"] == receipt["compiledBundleSha256"]
        assert metadata["files"] and all(f["path"].endswith(".ts") for f in metadata["files"])
        file = metadata["files"][0]
        async with httpx.AsyncClient(
            base_url=str(c.base_url), cookies=c.cookies, headers=c.headers
        ) as raw:
            response = await raw.get(source, params={"path": file["path"]})
            assert response.status_code == 200
            actual = response.content
            assert sha256(actual).hexdigest() == file["sha256"] and len(actual) == file["sizeBytes"]
            assert response.headers["Content-Type"].startswith("text/plain")
            assert response.headers["X-Content-Type-Options"] == "nosniff"
            assert response.headers["Cache-Control"] == "private, no-store"
            assert "sandbox" in response.headers["Content-Security-Policy"]
            for path in [
                "package.json",
                "../../etc/passwd",
                file["sha256"],
                "trace.zip",
                "source/asset-snapshot.json",
            ]:
                assert (await raw.get(source, params={"path": path})).status_code == 404
            foreign = source.replace(f"/workspaces/{ws}/", f"/workspaces/{other_ws}/")
            assert (await raw.get(foreign, params={"path": file["path"]})).status_code == 404
            second = await c.post(
                f"/api/v1/workspaces/{ws}/resources",
                json={
                    "kind": "DATASET",
                    "key": "data",
                    "name": "Data",
                    "content": {
                        "kind": "DATASET",
                        "document": {
                            "schemaVersion": "1.0",
                            "columns": {"name": "string"},
                            "rows": [{"key": "one", "values": {"name": "literal"}}],
                        },
                    },
                },
            )
            assert second.status_code == 201
            mismatched = source.replace(
                f"/resources/{rid}/", f"/resources/{second.json()['data']['id']}/"
            )
            assert (await raw.get(mismatched, params={"path": file["path"]})).status_code == 404
            # Corrupt actual retained bytes, then length. The original descriptor and receipt stay untouched.
            async with db.sessions.begin() as session:
                artifact = await session.get(Artifact, (ws, file["sha256"]))
                artifact.content = actual + b"tampered"
            corrupt = await raw.get(source, params={"path": file["path"]})
            assert corrupt.status_code == 409 and corrupt.json()["code"] == "INVALID_ARTIFACT"
            async with db.sessions.begin() as session:
                artifact = await session.get(Artifact, (ws, file["sha256"]))
                artifact.content = actual
                artifact.size_bytes = len(actual) + 1
            assert (await raw.get(source, params={"path": file["path"]})).status_code == 409
            async with db.sessions.begin() as session:
                artifact = await session.get(Artifact, (ws, file["sha256"]))
                artifact.size_bytes = len(actual)
            assert (await raw.get(source, params={"path": file["path"]})).content == actual
        uid = await new_member(c, ws, "source-viewer@example.com", "VIEWER")
        async with client(c, "source-viewer@example.com") as viewer:
            assert (await viewer.get(source, params={"path": file["path"]})).status_code == 200
            assert (await viewer.get(foreign, params={"path": file["path"]})).status_code == 403
            assert (await c.delete(f"/api/v1/workspaces/{ws}/members/{uid}")).status_code == 200
            assert (await viewer.get(source, params={"path": file["path"]})).status_code == 403
        # Failed actual compilation projects a stable safe code and cannot create a receipt.
        bad = await c.post(
            f"/api/v1/workspaces/{ws}/resources",
            json={
                "kind": "CASE",
                "key": "bad",
                "name": "Bad",
                "content": {
                    "kind": "CASE",
                    "document": {
                        "schemaVersion": "1.0",
                        "caseKey": "bad",
                        "title": "Bad",
                        "kind": "READ",
                        "roleKey": "reader",
                        "catalogVersionId": vid,
                        "steps": [{"id": "missing", "action": "click", "target": "missing"}],
                    },
                },
            },
        )
        assert bad.status_code == 201
        bad_base = f"/api/v1/workspaces/{ws}/resources/{bad.json()['data']['id']}"
        candidate = (await c.get(bad_base + "/validation-preview")).json()["data"]
        failed = await c.post(
            bad_base + "/validate",
            json={"revision": candidate["revision"], "sourceHash": candidate["sourceHash"]},
        )
        assert failed.status_code == 202
        await agent_once(profile, release)
        failed_job = f"/api/v1/workspaces/{ws}/jobs/{failed.json()['data']['id']}"
        failure = (await c.get(failed_job)).json()["data"]
        assert failure["outcome"] == "ERROR" and failure["errorCode"] == "UNKNOWN_ELEMENT"
        assert (
            "issues" not in failure
            and (await c.get(failed_job + "/validation-receipt")).status_code == 409
        )
    finally:
        # agent_once waits for the foreground Agent and native guardian before returning.
        shutil.rmtree(profile)
        if previous is None:
            approved.unlink(missing_ok=True)
        else:
            approved.write_bytes(previous)
