import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { validateSchema, type OfflineResultV1 } from "../../packages/contracts/src/index";
import { LocalStore } from "../../apps/runtime/src/offline/store";

/**
 * 历史兼容夹具只在自有测试档案写入明确标识的旧格式记录，供断网授权读取验证，不调用退役执行或上传；
 * 两条合成记录分别属于当前空间和另一空间，读取器必须隔离它们；历史通过结果保留离线来源及阻断门禁，不冒充联网回执。
 */
export async function seedHistoricalReports(profile: string, workspaceId: string) {
    const root = join(profile, "offline");
    const store = await LocalStore.open(root);
    store.close();
    const runId = randomUUID();
    const foreignRunId = randomUUID();
    const foreignWorkspaceId = randomUUID();
    const result: OfflineResultV1 = {
        schemaVersion: "1.0",
        workspaceId,
        bundleId: randomUUID(),
        localRunId: runId,
        deviceId: randomUUID(),
        source: "OFFLINE_IMPORT",
        trustStatus: "USER_REGISTERED",
        dirty: false,
        revocationStatus: "UNKNOWN",
        manifestSha256: "1".repeat(64),
        startedAt: "2020-01-01T00:00:00Z",
        finishedAt: "2020-01-01T00:00:01Z",
        outcome: "PASSED",
        actualEnvironment: {
            schemaVersion: "1.0",
            baseURL: "https://historical-fixture.invalid",
            apiBaseURL: "https://historical-fixture.invalid",
            allowedOrigins: ["https://historical-fixture.invalid"],
            locale: "en",
            timezone: "UTC",
            roles: [
                {
                    roleKey: "reader",
                    authAdapterVersionId: randomUUID(),
                    secretRef: "historical-fixture",
                    secretVersionId: randomUUID(),
                },
            ],
        },
        attempts: [
            {
                attemptId: randomUUID(),
                caseVersionId: randomUUID(),
                attemptNo: 1,
                outcome: "PASSED",
                cleanupStatus: "NOT_REQUIRED",
                processStopped: true,
                lastSequence: 0,
                events: [],
                artifacts: [],
            },
        ],
    };
    if (validateSchema("OfflineResultV1", result).length) throw new Error("HISTORICAL_FIXTURE_INVALID");
    const database = new DatabaseSync(join(root, "veriq.sqlite"));
    try {
        const insert = database.prepare(
            "INSERT INTO veriq_local_runs(id,workspace_id,created_at,state,result) VALUES(?,?,?,'FINISHED',?)",
        );
        insert.run(runId, workspaceId, result.startedAt, JSON.stringify(result));
        insert.run(
            foreignRunId,
            foreignWorkspaceId,
            result.startedAt,
            JSON.stringify({ ...result, localRunId: foreignRunId, workspaceId: foreignWorkspaceId }),
        );
    } finally {
        database.close();
    }
    return { runId, foreignRunId, foreignWorkspaceId, result };
}
