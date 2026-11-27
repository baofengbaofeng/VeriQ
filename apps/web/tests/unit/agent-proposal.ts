/**
 * 用公开组件渲染服务端已审核的提案及回执，验证操作名称、草稿证据和运行标识在审批与历史界面中分别展示。
 */
import assert from "node:assert/strict";
import { before, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { appI18n } from "../../src/locale";
import { ActionReceipt, Proposal } from "../../src/features/agent/Proposal";
import type { AgentSchemas } from "../../src/features/agent/adapters";

const resourceId = "32dca1f0-385f-42c6-8bfc-415029cc83ee";
const jobId = "62170262-26cf-4051-bdc8-95cadc31090c";
const receiptId = "98d541aa-1b85-4b3c-866b-98f81539455b";
const versionId = "e2c58c79-60da-43bb-a135-235865e3812a";
const source = { resourceId, revision: 17, sourceHash: "ac".repeat(32) };
const proof = { validationJobId: jobId, validationReceiptId: receiptId };
const sourceRunId = "d84e31c8-12fe-4705-a2dd-34a23c14a4cf";
const runId = "2717bc50-23bc-4553-bd4b-598fc8707b53";
const snapshot = { sourceRunId, sourceSnapshotHash: "bf".repeat(32) };

before(() => appI18n.changeLanguage("en"));

const resourceFields = { "Resource ID": resourceId, Revision: 17, "Draft source hash": source.sourceHash };
const jobFields = { ...resourceFields, "Validation job ID": jobId };
const publishFields = { ...jobFields, "Validation receipt ID": receiptId };
const runFields = { "Source run ID": sourceRunId, "Source snapshot hash": snapshot.sourceSnapshotHash };
type ExpectedFields = Readonly<Record<string, string | number>>;

const proposals: [AgentSchemas["AgentProposal"], string, ExpectedFields][] = [
    [{ type: "VALIDATE_RESOURCE", ...source }, "Confirm validation", resourceFields],
    [{ type: "PUBLISH_RESOURCE", ...source, ...proof }, "Confirm publication", publishFields],
    [{ type: "CANCEL_RUN", ...snapshot }, "Confirm cancellation", runFields],
    [{ type: "RERUN_RUN", ...snapshot }, "Confirm rerun", runFields],
];

const receipts: [AgentSchemas["AgentReceipt"], string, ExpectedFields][] = [
    [{ type: "VALIDATE_RESOURCE", ...source, validationJobId: jobId }, "Validation requested", jobFields],
    [
        { type: "PUBLISH_RESOURCE", ...source, ...proof, versionId },
        "Resource published",
        { ...publishFields, "Version ID": versionId },
    ],
    [{ type: "CANCEL_RUN", runId: sourceRunId }, "Cancellation requested", { "Source run ID": sourceRunId }],
    [{ type: "RERUN_RUN", sourceRunId, runId }, "Rerun created", { "Source run ID": sourceRunId, "New run ID": runId }],
];

for (const [proposal, label, values] of proposals) {
    test(`approval identifies the frozen target and the specific ${proposal.type} action`, () => {
        const render = (confirm?: () => void) =>
            renderToStaticMarkup(createElement(Proposal, { proposal, confirm, disabled: true }));
        const actionable = render(() => {});
        assert.ok(actionable.includes(`>${label}</button>`));
        assert.match(actionable, /<button[^>]* disabled/);
        for (const [field, value] of Object.entries(values))
            assert.ok(actionable.includes(`<dt>${field}</dt><dd>${value}</dd>`), field);
        assert.doesNotMatch(render(), /<button/);
    });
}
for (const [receipt, title, values] of receipts) {
    test(`history identifies the actual result of ${receipt.type} without a confirmation action`, () => {
        const card = renderToStaticMarkup(createElement(ActionReceipt, { receipt }));
        assert.ok(card.includes(`aria-label="${title}"`), card);
        for (const [field, value] of Object.entries(values))
            assert.ok(card.includes(`<dt>${field}</dt><dd>${value}</dd>`), field);
        assert.doesNotMatch(card, /<button/);
    });
}
