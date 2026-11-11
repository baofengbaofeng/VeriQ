"""T14 actual HTTP boundary; T04 fixture seeds immutable compiler provenance only."""

import sys
from pathlib import Path
from test_auth import setup, login
from test_workspace import workspace

sys.path.insert(0, str(Path(__file__).parents[1] / "execution"))
from test_runs_mysql import published, environment


async def test_published_selection_exports_secret_free_archive(
    approved_metadata, site, monkeypatch
):
    c, db = site
    await setup(c)
    await login(c)
    ws = await workspace(c)
    from veriq_server.repositories.resource import ResourceRepository
    from veriq_server.auth.authorization import WorkspaceScope

    async with db.sessions.begin() as session:
        for body in approved_metadata.values():
            await ResourceRepository(session, WorkspaceScope(ws)).store(body)
    env = await environment(c, db, ws)
    catalog = await published(
        c,
        db,
        ws,
        "catalog",
        "ELEMENT_CATALOG",
        {
            "schemaVersion": "1.0",
            "elements": [{"key": "save", "locator": {"by": "testId", "value": "save"}}],
        },
    )
    case = await published(
        c,
        db,
        ws,
        "case",
        "CASE",
        {
            "schemaVersion": "1.0",
            "caseKey": "read",
            "title": "Read",
            "kind": "READ",
            "roleKey": "reader",
            "catalogVersionId": catalog,
            "steps": [{"id": "open", "action": "goto", "path": "/"}],
        },
    )
    response = await c.post(
        f"/api/v1/workspaces/{ws}/bundles",
        json={
            "caseVersionIds": [case],
            "environmentVersionId": env,
            "validationStatus": "VALIDATED",
        },
    )
    assert response.status_code == 201, response.text
    dto = response.json()["data"]
    manifest_response = await c.get(f"/api/v1/workspaces/{ws}/bundles/{dto['id']}/manifest")
    assert manifest_response.status_code == 200
    assert manifest_response.json()["data"]["snapshotSha256"] == dto["snapshotSha256"]
    archive = await c.get(f"/api/v1/workspaces/{ws}/bundles/{dto['id']}/download")
    assert archive.status_code == 200, archive.text
    assert b"synthetic-business-secret" not in archive.content

    import io
    import zipfile
    import json
    from hashlib import sha256

    with zipfile.ZipFile(io.BytesIO(archive.content)) as z:
        names = z.namelist()
        for name in names:
            assert b"synthetic-business-secret" not in z.read(name)
        manifest = json.loads(z.read("manifest.json"))
        snapshot = json.loads(z.read("snapshot.json"))
        assert {a["versionId"] for a in snapshot["assets"]} == {env, catalog, case}
        assert set(names) == {
            "manifest.json",
            "manifest.sig",
            *(f["path"] for f in manifest["files"]),
        }
        for f in manifest["files"]:
            raw = z.read(f["path"])
            assert len(raw) == f["sizeBytes"] and sha256(raw).hexdigest() == f["sha256"]

    from test_lease_mysql import device

    credentials = await device(c, ws)
    headers = {"Authorization": "Bearer " + credentials["deviceToken"]}
    assert (await c.get("/internal/v1/issuer")).status_code == 401
    trust = await c.get("/internal/v1/issuer", headers=headers)
    assert trust.status_code == 200 and trust.json()["data"]["keys"]
    native = f"/internal/v1/workspaces/{ws}/bundles/{dto['id']}/download"
    assert (await c.get(native)).status_code == 401
    assert (await c.get(native, headers=headers)).content == archive.content
    assert (
        await c.post(f"/api/v1/workspaces/{ws}/runtimes/{credentials['runnerId']}/revoke", json={})
    ).status_code == 200
    assert (await c.get(native, headers=headers)).status_code == 401

    # Real concurrent authorization mutation while compression is outside DB locks.
    import asyncio
    import threading
    from test_workspace import new_member, client
    from veriq_server.services.bundle import BundleService

    editor_id = await new_member(c, ws, "export-editor@example.com", "EDITOR")
    started, release = threading.Event(), threading.Event()
    original = BundleService.assemble

    def held(prepared):
        result = original(prepared)
        started.set()
        assert release.wait(10), "Test did not release archive assembly"
        return result

    monkeypatch.setattr(BundleService, "assemble", staticmethod(held))
    async with client(c, "export-editor@example.com") as editor:
        pending = asyncio.create_task(
            editor.post(
                f"/api/v1/workspaces/{ws}/bundles",
                json={
                    "caseVersionIds": [case],
                    "environmentVersionId": env,
                    "validationStatus": "VALIDATED",
                },
            )
        )
        try:
            assert await asyncio.to_thread(started.wait, 5)
            removed = await asyncio.wait_for(
                c.delete(f"/api/v1/workspaces/{ws}/members/{editor_id}"), 3
            )
            assert removed.status_code == 200
        finally:
            release.set()
        denied = await pending
        assert denied.status_code == 403
    assert len((await c.get(f"/api/v1/workspaces/{ws}/bundles")).json()["data"]["items"]) == 1


async def test_no_runtime_debug_dsl_only_requires_explicit_status_and_editor(site, tmp_path):
    import io
    import json
    import zipfile
    import subprocess
    from test_publish import create, queue
    from veriq_server.bundles.issuer import Issuer
    from veriq_server.db import Job

    c, db = site
    await setup(c)
    await login(c)
    ws = await workspace(c)
    env = await environment(c, db, ws)
    catalog = await published(
        c,
        db,
        ws,
        "catalog",
        "ELEMENT_CATALOG",
        {
            "schemaVersion": "1.0",
            "elements": [{"key": "save", "locator": {"by": "testId", "value": "save"}}],
        },
    )
    path = await create(
        c,
        ws,
        "draft",
        {
            "kind": "CASE",
            "document": {
                "schemaVersion": "1.0",
                "caseKey": "draft",
                "title": "Draft",
                "kind": "READ",
                "roleKey": "reader",
                "catalogVersionId": catalog,
                "steps": [{"id": "open", "action": "goto", "path": "/"}],
            },
        },
    )
    _, job = await queue(c, path)
    endpoint = f"/api/v1/workspaces/{ws}/bundles"
    req = {
        "draftValidationJobId": job["id"],
        "environmentVersionId": env,
        "validationStatus": "UNVALIDATED_DEBUG",
    }
    wrong = await c.post(endpoint, json={**req, "validationStatus": "VALIDATED"})
    assert wrong.status_code == 400
    response = await c.post(endpoint, json=req)
    assert response.status_code == 201, response.text
    async with db.sessions() as s:
        candidate = await s.get(Job, job["id"])
        assert candidate.state == "QUEUED" and candidate.active_attempt_id is None
    archive = await c.get(endpoint + f"/{response.json()['data']['id']}/download")
    assert archive.status_code == 200
    with zipfile.ZipFile(io.BytesIO(archive.content)) as z:
        assert not any(n.startswith("compiled/") for n in z.namelist())
        assert "draft/source.json" in z.namelist()
        assert (
            json.loads(z.read("snapshot.json"))["validationTarget"]
            == json.loads(z.read("draft/source.json"))["validationTarget"]
        )
    # Actual Node verifier consumes Python's exact signature, no self-trusting archive key.
    archive_path = tmp_path / "debug.zip"
    archive_path.write_bytes(archive.content)
    public = Issuer(tmp_path / "issuer" / "keys.json").public()
    public_path = tmp_path / "public.json"
    public_path.write_text(json.dumps(public))
    profile = tmp_path / "profile"
    command = [
        "pnpm",
        "--filter",
        "@veriq/runtime",
        "exec",
        "node",
        "--import",
        "tsx",
        "src/cli.ts",
        "--config-dir",
        str(profile),
    ]
    result = subprocess.run(
        [
            *command,
            "trust",
            "bind",
            str(public_path),
            "--origin",
            "https://control.test",
            "--fingerprint",
            public["keys"][0]["fingerprint"],
        ],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr
    destination = tmp_path / "verified"
    reject = subprocess.run(
        [*command, "bundle", "verify", str(archive_path), "--destination", str(destination)],
        capture_output=True,
        text=True,
    )
    assert reject.returncode != 0 and "BUNDLE_DEBUG_REQUIRED" in reject.stderr
    result = subprocess.run(
        [
            *command,
            "bundle",
            "verify",
            str(archive_path),
            "--destination",
            str(destination),
            "--debug",
        ],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr
    assert "revocation UNKNOWN" in result.stdout
    inspected = subprocess.run(
        [
            "pnpm",
            "--filter",
            "@veriq/runtime",
            "exec",
            "node",
            "--import",
            "tsx",
            "tests/inspect-offline.mjs",
            str(archive_path),
            str(profile),
            str(tmp_path / "inspected"),
        ],
        capture_output=True,
        text=True,
    )
    assert inspected.returncode == 0, inspected.stderr
    assert "Verified local resource adapter" in inspected.stdout


async def test_bundle_selection_and_download_require_current_workspace_authority(
    approved_metadata, site
):
    from test_workspace import new_member, client
    from test_publish import create, queue

    c, db = site
    await setup(c)
    await login(c)
    ws = await workspace(c)
    env = await environment(c, db, ws)
    catalog = await published(
        c,
        db,
        ws,
        "catalog",
        "ELEMENT_CATALOG",
        {
            "schemaVersion": "1.0",
            "elements": [{"key": "save", "locator": {"by": "testId", "value": "save"}}],
        },
    )
    path = await create(
        c,
        ws,
        "draft",
        {
            "kind": "CASE",
            "document": {
                "schemaVersion": "1.0",
                "caseKey": "draft",
                "title": "Draft",
                "kind": "READ",
                "roleKey": "reader",
                "catalogVersionId": catalog,
                "steps": [{"id": "open", "action": "goto", "path": "/"}],
            },
        },
    )
    _, job = await queue(c, path)
    req = {
        "draftValidationJobId": job["id"],
        "environmentVersionId": env,
        "validationStatus": "UNVALIDATED_DEBUG",
    }
    result = await c.post(f"/api/v1/workspaces/{ws}/bundles", json=req)
    assert result.status_code == 201, result.text
    other = await workspace(c, "foreign")
    foreign = await c.post(f"/api/v1/workspaces/{other}/bundles", json=req)
    assert foreign.status_code == 404
    missing = await c.get(
        f"/api/v1/workspaces/{other}/bundles/{result.json()['data']['id']}/download"
    )
    assert missing.status_code == 404
    await new_member(c, ws, email="executor@example.com", role="EXECUTOR")
    async with client(c, "executor@example.com") as executor:
        denied = await executor.post(f"/api/v1/workspaces/{ws}/bundles", json=req)
        assert denied.status_code == 403
        download = f"/api/v1/workspaces/{ws}/bundles/{result.json()['data']['id']}/download"
        # A DSL-only archive exposes draft content and requires EDIT on every read too.
        assert (await executor.get(download)).status_code == 403
    # Duplicate/both/empty selections are canonical HTTP errors, never partial exports.
    for data in [
        {"caseVersionIds": []},
        {"caseVersionIds": [catalog, catalog]},
        {"caseVersionIds": [catalog], "suiteVersionId": catalog},
    ]:
        response = await c.post(
            f"/api/v1/workspaces/{ws}/bundles",
            json={"environmentVersionId": env, "validationStatus": "VALIDATED", **data},
        )
        assert response.status_code == 400
