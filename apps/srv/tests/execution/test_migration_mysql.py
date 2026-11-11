"""The new head preserves existing queued validation and Workspace source bytes."""

from pathlib import Path
from alembic import command
from alembic.config import Config
from sqlalchemy import text
from test_auth import setup, login
from test_workspace import workspace
from veriq_server.db import Job, Artifact


async def test_upgrade_preserves_0005_queued_validate_and_source(site):
    c, db = site
    await setup(c)
    await login(c)
    ws = await workspace(c)
    resource = (
        await c.post(
            f"/api/v1/workspaces/{ws}/resources",
            json={
                "kind": "ELEMENT_CATALOG",
                "key": "migration",
                "name": "Migration",
                "content": {
                    "kind": "ELEMENT_CATALOG",
                    "document": {
                        "schemaVersion": "1.0",
                        "elements": [{"key": "save", "locator": {"by": "testId", "value": "save"}}],
                    },
                },
            },
        )
    ).json()["data"]
    path = f"/api/v1/workspaces/{ws}/resources/{resource['id']}"
    preview = (await c.get(path + "/validation-preview")).json()["data"]
    queued = await c.post(
        path + "/validate",
        json={"revision": preview["revision"], "sourceHash": preview["sourceHash"]},
    )
    assert queued.status_code == 202, queued.text
    job_id = queued.json()["data"]["id"]
    async with db.sessions() as session:
        job = await session.get(Job, job_id)
        snapshot_hash, manifest_hash = job.snapshot_hash, job.manifest_hash
        source = (await session.get(Artifact, (ws, snapshot_hash))).content
    config = Config()
    import veriq_server

    config.set_main_option(
        "script_location", str(Path(veriq_server.__file__).parent / "migrations")
    )
    async with db.engine.connect() as connection:

        def change(sync):
            config.attributes["connection"] = sync
            command.downgrade(config, "0005_runtimes")
            row = sync.execute(
                text("SELECT state, snapshot_hash, manifest_hash FROM veriq_jobs WHERE id=:id"),
                {"id": job_id},
            ).one()
            assert tuple(row) == ("QUEUED", snapshot_hash, manifest_hash)
            command.upgrade(config, "head")

        await connection.run_sync(change)
        await connection.commit()
    async with db.sessions() as session:
        job = await session.get(Job, job_id)
        assert job.state == "QUEUED" and job.fence == 0 and job.max_retries == 0
        assert job.snapshot_hash == snapshot_hash and job.manifest_hash == manifest_hash
        assert (await session.get(Artifact, (ws, snapshot_hash))).content == source
    assert (await c.get(path)).status_code == 200
    assert (await c.get("/api/v1/account")).status_code == 200
