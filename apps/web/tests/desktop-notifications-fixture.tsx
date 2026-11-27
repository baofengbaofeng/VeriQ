/**
 * 在收件箱表单的真实路由内挂载可观察的宿主传输与独立报表适配器，验证表单归属、私有详情和报表跳转。
 */
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { scopeAgentFormSignal } from "../src/agent-form-origin";
import { ApiError, installHostTransport } from "../src/api";
import { Auth } from "../src/auth-context";
import { InlineFormRouter } from "../src/features/agent/InlineFormRouter";
import type { WorkspaceFormReference } from "../src/features/agent/workspace-forms";
import { LocalReportAdapter } from "../src/features/reports/adapters";
import { PinnedFormWorkspace } from "../src/features/workspaces/WorkspaceContext";
import { PinnedFormDirectory } from "../src/features/workspaces/WorkspaceDirectory";
import { AppLocaleProvider } from "../src/locale-ui";
import { OperationFeedbackProvider } from "../src/operation-feedback";

declare global {
    interface Window {
        inboxTestCall(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<unknown>;
    }
}

const query = new URLSearchParams(location.search);
const workspaceId = query.get("workspace");
const runId = query.get("run");
const turnId = query.get("turn");
const container = document.getElementById("root");
if (!workspaceId || !runId || !turnId || !container) throw new Error("Missing fixture context");
const stamp = "2026-01-01T12:00:00Z";
const controller = new AbortController();
const reference: WorkspaceFormReference = {
    workspaceId,
    turnId,
    sessionId: crypto.randomUUID(),
    capability: "NOTIFICATION_INBOX",
};
const signal = scopeAgentFormSignal(controller.signal, turnId, reference.capability);
const user = {
    id: crypto.randomUUID(),
    displayName: "Reader",
    email: "reader@example.test",
    disabled: false,
    systemAdmin: false,
    createdAt: stamp,
};
installHostTransport({
    async json(path, method, data, active, headers) {
        active?.throwIfAborted();
        const result = await window.inboxTestCall(method, path, data, headers);
        active?.throwIfAborted();
        if (result === "DENIED") throw new ApiError("FORBIDDEN", "Access ended", 403, "fixture");
        return result;
    },
    async stream(path) {
        await window.inboxTestCall("STREAM", path);
        throw new Error("Unexpected notification stream");
    },
    async binary(path) {
        await window.inboxTestCall("BINARY", path);
        throw new Error("Unexpected binary transport");
    },
});
const adapter = new LocalReportAdapter({
    workspaceId,
    history: {},
    artifacts: {},
    reports: [
        {
            run: {
                id: runId,
                workspaceId,
                state: "FINISHED",
                source: "MANAGED_CLOUD",
                outcome: "PASSED",
                snapshotHash: "a".repeat(64),
                createdAt: stamp,
            },
            cases: [],
            gateAtExecution: { passed: true, reasons: [] },
            gateNow: { passed: true, reasons: [] },
            statistics: { caseCount: 0, firstPassCount: 0, retryPassCount: 0, infrastructureErrorCount: 0 },
        },
    ],
});
const getReport = adapter.report;
adapter.report = async (id) => {
    await window.inboxTestCall("REPORT", id);
    return getReport(id);
};
const root = createRoot(container);
root.render(
    <MemoryRouter>
        <AppLocaleProvider>
            <Auth.Provider value={{ user, refresh: async () => {}, setupComplete: () => {} }}>
                <OperationFeedbackProvider>
                    <PinnedFormWorkspace selected={workspaceId} signal={signal}>
                        <PinnedFormDirectory id={workspaceId} signal={signal}>
                            <InlineFormRouter
                                href="/notifications"
                                reference={reference}
                                signal={signal}
                                nativeReportAdapter={adapter}
                            />
                        </PinnedFormDirectory>
                    </PinnedFormWorkspace>
                    <button
                        type="button"
                        onClick={() => {
                            controller.abort();
                            root.unmount();
                        }}
                    >
                        Close fixture form
                    </button>
                </OperationFeedbackProvider>
            </Auth.Provider>
        </AppLocaleProvider>
    </MemoryRouter>,
);
