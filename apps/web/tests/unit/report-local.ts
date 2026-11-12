import { test } from "node:test";
import assert from "node:assert/strict";
import { LocalReportAdapter } from "../../src/features/reports/adapters";
test("local report snapshot rejects orphan evidence and history before host access", () => {
    assert.throws(
        () =>
            new LocalReportAdapter({
                workspaceId: "ws",
                reports: [],
                history: { foreign: [] },
                artifacts: {},
            }),
        /Attempt/,
    );
    assert.throws(
        () =>
            new LocalReportAdapter({
                workspaceId: "ws",
                reports: [],
                history: {},
                artifacts: { foreign: [] },
            }),
        /Attempt/,
    );
});
