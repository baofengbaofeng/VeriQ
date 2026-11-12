import { it, expect } from "vitest";
import { fixture } from "./helpers.js";
import { snapshot, id } from "../../compiler/tests/helpers.js";
import { analyze } from "../../compiler/src/index.js";
import { executeCase } from "../src/index.js";
import type { ExecutionSnapshotV1 } from "@veriq/contracts";

it.each(["GET", "POST"] as const)(
    "classifies actual business %s only after the complete Context closes",
    async (method) => {
        const f = await fixture();
        try {
            const source = snapshot([
                { id: "request", action: "apiRequest", method, path: "/save" },
            ]);
            const execution: ExecutionSnapshotV1 = {
                schemaVersion: "1.0",
                workspaceId: source.workspaceId,
                runId: id(10),
                caseExecutionId: id(11),
                caseVersionId: id(1),
                assetSourceHash: source.sourceHash,
                environmentVersionId: id(12),
                environment: {
                    ...f.options.environment,
                    roles: [
                        {
                            roleKey: "reader",
                            authAdapterVersionId: id(13),
                            secretRef: "reader",
                            secretVersionId: id(14),
                        },
                    ],
                },
                roleKey: "reader",
                browser: "chromium",
                variables: {},
                secretVersions: [{ secretRef: "reader", versionId: id(14) }],
                namespace: "retry-observation",
                attemptNo: 1,
            };
            const result = await executeCase(analyze(source).cases[0]!, source, {
                page: f.page,
                execution,
                lifecycle: { authenticate: async () => ({ identityId: "reader" }) },
                redact: (v) => v,
                finalizeExecution: async (context: import("@playwright/test").BrowserContext) =>
                    context.close(),
            });
            expect(result.businessOutcome).toBe("PASSED");
            expect(result.retrySafety).toBe(
                method === "GET" ? "READ_ONLY_OBSERVED" : "WRITE_POSSIBLE",
            );
            expect(f.page.isClosed()).toBe(true);
        } finally {
            await f.close();
        }
    },
);

import { RetryObservation } from "../src/retry-safety.js";
it.each(["popup", "frame", "websocket", "worker", "workerWebSocket"] as const)(
    "observes %s activity outside the primary page",
    async (kind) => {
        const f = await fixture();
        const observation = new RetryObservation(f.page.context(), false);
        try {
            if (kind === "popup") {
                const popup = f.page.waitForEvent("popup");
                await f.page.evaluate(() => window.open("/", "_blank"));
                const child = await popup;
                await child.waitForLoadState();
                await child.evaluate(() => fetch("/save", { method: "POST" }));
            } else if (kind === "frame") {
                const navigating = f.page.waitForEvent(
                    "framenavigated",
                    (frame) => frame !== f.page.mainFrame(),
                );
                await f.page.evaluate(() => {
                    const frame = document.createElement("iframe");
                    frame.src = "/";
                    document.body.append(frame);
                });
                const frame = await navigating;
                await frame.evaluate(() => fetch("/save", { method: "POST" }));
            } else if (kind === "workerWebSocket") {
                await f.page.evaluate(async (origin) => {
                    const worker = new Worker(
                        URL.createObjectURL(
                            new Blob(
                                [
                                    `const ws=new WebSocket('${origin.replace("http", "ws")}/socket');ws.onerror=()=>postMessage('attempted');`,
                                ],
                                { type: "text/javascript" },
                            ),
                        ),
                    );
                    await new Promise((resolve) => (worker.onmessage = resolve));
                }, f.origin);
            } else if (kind === "worker") {
                await f.page.evaluate(async (origin) => {
                    const worker = new Worker(
                        URL.createObjectURL(
                            new Blob(
                                [
                                    `fetch('${origin}/save', {method:'POST'}).then(()=>postMessage('done'))`,
                                ],
                                { type: "text/javascript" },
                            ),
                        ),
                    );
                    await new Promise((resolve) => (worker.onmessage = resolve));
                }, f.origin);
            } else {
                const socket = f.page.waitForEvent("websocket");
                await f.page.evaluate(() => {
                    new WebSocket(location.origin.replace("http", "ws") + "/socket");
                });
                await socket;
            }
            await f.page.context().close();
            expect(observation.finish(true)).toBe("WRITE_POSSIBLE");
        } finally {
            await f.close();
        }
    },
);
it("does not assert read-only for an incomplete observation window or a WRITE declaration", async () => {
    const f = await fixture();
    try {
        expect(new RetryObservation(f.page.context(), false).finish(false)).toBe("UNKNOWN");
        const declared = new RetryObservation(f.page.context(), true);
        await f.page.context().close();
        expect(declared.finish(true)).toBe("WRITE_POSSIBLE");
    } finally {
        await f.close();
    }
});
