import { expect, it } from "vitest";
import { validateCaseSchema, type ElementCatalogV1, type ExecutionSnapshotV1 } from "@veriq/contracts";
import {
    applyRecordingEvent,
    buildCaseDraft,
    newRecordingDraft,
} from "../../../apps/desktop/src/renderer/recording/draft-model.js";
import { analyze } from "../../compiler/src/index.js";
import { asset, id, rehash, snapshot } from "../../compiler/tests/helpers.js";
import { executeCase } from "../src/index.js";
import { fixture } from "./helpers.js";

it("replays one recorded workspace case with independent data rows and selects cleanup from the outcome", async () => {
    const directory: ElementCatalogV1 = {
        schemaVersion: "1.0",
        elements: [
            { key: "name", locator: { by: "veriqId", value: "name" } },
            { key: "check", locator: { by: "veriqId", value: "check" } },
        ],
    };
    const rows = [
        { key: "match", values: { input: "first row", expected: "first row" } },
        { key: "mismatch", values: { input: "second row", expected: "different value" } },
    ];
    const initial = {
        ...newRecordingDraft(),
        title: "Recorded and parameterized",
        roleKey: "reader",
        catalogVersionId: id(2),
        datasetVersionId: id(3),
    };
    const captured = applyRecordingEvent(initial, {
        sessionId: "recording",
        navigation: 1,
        id: "recorded_click",
        type: "click",
        candidates: [{ locator: { by: "veriqId", value: "check" }, matches: 1 }],
    });
    const action = captured.steps[0]!;
    const authored = buildCaseDraft(
        {
            ...captured,
            prepare: [{ step: { id: "prepare_browser", action: "goto", path: "/" } }],
            steps: [
                {
                    step: { id: "enter_data", action: "fill", target: "name", value: "{{data.input}}" },
                    target: { catalogVersionId: id(2), key: "name" },
                },
                {
                    ...action,
                    step: {
                        ...action.step,
                        afterAssertions: [
                            {
                                id: "verify_value",
                                type: "ui",
                                target: "name",
                                severity: "BLOCK",
                                expectedSource: "Data row",
                                operator: "valueEquals",
                                expected: "{{data.expected}}",
                                timeoutMs: 1000,
                            },
                        ],
                    },
                },
            ],
            SUCCESS: [{ step: { id: "success_cleanup", action: "goto", path: "/recorded-clean-success" } }],
            FAILURE: [{ step: { id: "failure_cleanup", action: "goto", path: "/recorded-clean-failure" } }],
        },
        { versionId: id(2), document: directory },
        validateCaseSchema,
    );
    expect(authored.diagnostics).toEqual([]);
    const document = authored.content!.document;
    const source = snapshot(
        document.steps,
        [asset(3, "DATASET", { schemaVersion: "1.0", columns: { input: "string", expected: "string" }, rows })],
        document,
    );
    source.assets[1] = asset(2, "ELEMENT_CATALOG", directory);
    rehash(source);
    const analysis = analyze(source);
    expect(analysis.issues).toEqual([]);
    for (const [index, row] of rows.entries()) {
        const business = await fixture();
        try {
            const role = {
                roleKey: "reader",
                authAdapterVersionId: id(14),
                secretRef: "recording_test",
                secretVersionId: id(15),
            };
            const execution: ExecutionSnapshotV1 = {
                schemaVersion: "1.0",
                workspaceId: source.workspaceId,
                runId: id(11),
                caseExecutionId: id(20 + index),
                caseVersionId: id(1),
                assetSourceHash: source.sourceHash,
                environmentVersionId: id(13),
                environment: { ...business.options.environment, roles: [role] },
                roleKey: role.roleKey,
                browser: "chromium",
                variables: {},
                dataRow: row,
                datasetVersionId: id(3),
                secretVersions: [{ secretRef: role.secretRef, versionId: role.secretVersionId }],
                namespace: "recording_" + row.key,
                attemptNo: 1,
            };
            const result = await executeCase(analysis.cases[0]!, source, {
                page: business.page,
                execution,
                redact: (value) => value,
                lifecycle: { authenticate: async () => ({ identityId: "reader" }) },
            });
            const passed = index === 0;
            expect(result.businessOutcome).toBe(passed ? "PASSED" : "FAILED");
            expect(result.cleanupStatus).toBe("SUCCEEDED");
            expect(result.steps.find((step) => step.assertions.length)?.assertions[0]?.actual).toEqual({
                present: true,
                value: row.values.input,
            });
            expect(
                business.requests.filter(({ path }) => path.startsWith("/recorded-clean")).map(({ path }) => path),
            ).toEqual([passed ? "/recorded-clean-success" : "/recorded-clean-failure"]);
        } finally {
            await business.close();
        }
    }
}, 20000);
