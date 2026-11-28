import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedHistoricalReports } from "../../../tests/e2e/historical-profile.ts";
import { LocalReports } from "../../runtime/src/offline/reports.ts";

/**
 * 旧格式兼容数据经真实本机读取器保持空间隔离和离线门禁，验证当前产品的读取行为，而非只核对测试构造器自身返回值。
 */
test("retained compatibility reports preserve workspace authorization and blocked provenance", async (t) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "veriq-historical-profile-")));
    t.after(() => rm(root, { recursive: true, force: true }));
    const workspaceId = "11111111-1111-4111-8111-111111111111";
    const fixture = await seedHistoricalReports(root, workspaceId);
    const reports = new LocalReports(join(root, "offline"), () => false);
    const snapshot = await reports.snapshot(workspaceId, fixture.runId);
    assert.equal(snapshot.reports[0]!.run.source, "OFFLINE_IMPORT");
    assert.equal(snapshot.reports[0]!.run.outcome, "PASSED");
    assert.deepEqual(snapshot.reports[0]!.gateNow, {
        passed: false,
        reasons: ["OFFLINE_IMPORT", "REVOCATION_UNKNOWN", "RESULT_AUTHENTICITY_UNVERIFIED"],
    });
    await assert.rejects(reports.snapshot(workspaceId, fixture.foreignRunId), /LOCAL_RUN_NOT_FOUND/);
    await assert.rejects(reports.snapshot(fixture.foreignWorkspaceId, fixture.runId), /LOCAL_RUN_NOT_FOUND/);
});
