"""核对设备认证、首次领取及历史请求重放对在线时刻和平台库存的影响，通过 HTTP 观测设备当前的公开状态。"""

from uuid import uuid4

from sqlalchemy import text

from test_grants import ready, enroll, CAPABILITIES


async def test_presence_is_recent_authenticated_claim_not_registration_or_get(site):
    """登记后需要认证领取才能刷新在线时刻，推进数据库时间之后再次读取库存与过期心跳都应保持离线状态。"""
    c, db, ws = await ready(site)
    d = await enroll(c, ws)
    headers = {"Authorization": "Bearer " + d["deviceToken"]}
    info = (await c.get("/internal/v1/runtime", headers=headers)).json()["data"]
    assert info["status"] == "OFFLINE" and "lastSeenAt" not in info
    response = await c.post(
        "/internal/v1/jobs/claim",
        headers=headers,
        json={
            "runnerId": d["runnerId"],
            "clientRequestId": str(uuid4()),
            "capabilities": CAPABILITIES,
            "availableSlots": 1,
        },
    )
    assert response.status_code == 204
    info = (await c.get("/internal/v1/runtime", headers=headers)).json()["data"]
    assert info["status"] == "ONLINE"
    assert info["lastSeenAt"]
    async with db.sessions.begin() as session:
        await session.execute(
            text("UPDATE veriq_runtimes SET last_seen_at=UTC_TIMESTAMP()-INTERVAL 61 SECOND")
        )
    assert (await c.get("/internal/v1/runtime", headers=headers)).json()["data"][
        "status"
    ] == "OFFLINE"
    assert (
        await c.post(
            f"/internal/v1/attempts/{uuid4()}/heartbeat",
            headers=headers,
            json={"leaseToken": "x" * 43, "fencingToken": 1, "progress": {"phase": "RUNNING"}},
        )
    ).status_code in [403, 404, 409]
    assert (await c.get("/internal/v1/runtime", headers=headers)).json()["data"][
        "status"
    ] == "OFFLINE"


async def test_fresh_authenticated_claim_corrects_legacy_mac_architecture_only(site):
    """使用已认证设备的首次领取校正旧版库存中的架构，同时验证重放、跨设备和版本不匹配时都保留原记录。"""
    client, _, workspace = await ready(site)
    legacy = {**CAPABILITIES, "os": "darwin"}
    credential = await enroll(client, workspace, private=False, capabilities=legacy)
    assert (
        await client.put(
            f"/api/v1/workspaces/{workspace}/runtimes/{credential['runnerId']}/trust",
            json={"trustStatus": "MANAGED", "allowCredentialDelivery": True},
        )
    ).status_code == 200
    headers = {"Authorization": "Bearer " + credential["deviceToken"]}
    path = "/internal/v1/jobs/claim"

    async def inventory():
        response = await client.get("/internal/v1/runtime", headers=headers)
        assert response.status_code == 200
        return response.json()["data"]

    def claim(capabilities):
        return {
            "runnerId": credential["runnerId"],
            "clientRequestId": str(uuid4()),
            "availableSlots": 0,
            "capabilities": capabilities,
        }

    before = await inventory()
    assert before["trustStatus"] == "MANAGED" and before["allowCredentialDelivery"]
    old_request = claim(legacy)
    assert (await client.post(path, json=old_request, headers=headers)).status_code == 204
    updated = claim({**legacy, "arch": "arm64", "jobKinds": ["CLEANUP"]})
    assert (await client.post(path, json=updated)).status_code == 401
    assert (
        await client.post(path, json={**updated, "runnerId": str(uuid4())}, headers=headers)
    ).status_code == 403
    wrong_engine = claim({**legacy, "arch": "arm64", "engineVersion": "0.2.0"})
    assert (await client.post(path, json=wrong_engine, headers=headers)).status_code == 204
    assert (await inventory())["capabilities"] == legacy
    assert (await client.post(path, json=updated, headers=headers)).status_code == 204
    assert (await client.post(path, json=old_request, headers=headers)).status_code == 204
    assert (await client.post(path, json=updated, headers=headers)).status_code == 204
    after = await inventory()
    assert after["capabilities"] == {**legacy, "arch": "arm64"}
    for field in before.keys() - {"status", "lastSeenAt", "capabilities"}:
        assert after[field] == before[field]

    await assert_linux_inventory_unchanged(client, workspace, updated)


async def assert_linux_inventory_unchanged(client, workspace, mac_claim):
    """另行登记服务端已识别的 Linux 设备，核对带有其它平台架构的领取不会改变该设备原有的能力记录。"""
    linux = await enroll(client, workspace)
    linux_headers = {"Authorization": "Bearer " + linux["deviceToken"]}
    cross_platform = {**mac_claim, "clientRequestId": str(uuid4()), "runnerId": linux["runnerId"]}
    assert (
        await client.post("/internal/v1/jobs/claim", json=cross_platform, headers=linux_headers)
    ).status_code == 204
    info = (await client.get("/internal/v1/runtime", headers=linux_headers)).json()["data"]
    assert info["capabilities"] == CAPABILITIES
