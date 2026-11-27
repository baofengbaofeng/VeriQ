/**
 * 用户能够在文字和卡片中确认的动作受相同角色限制，具体短语不会把针对原提议的确认扩展到新的操作种类。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { agentConfirmation, canConfirmAgentAction } from "../../src/features/agent/confirmations";

test("resource publication, validation and run operations use the authority of the exact action", () => {
    assert.equal(canConfirmAgentAction("ADMIN", "PUBLISH_RESOURCE"), true);
    assert.equal(canConfirmAgentAction("EDITOR", "PUBLISH_RESOURCE"), false);
    assert.equal(canConfirmAgentAction("EDITOR", "VALIDATE_RESOURCE"), true);
    assert.equal(canConfirmAgentAction("EXECUTOR", "VALIDATE_RESOURCE"), false);
    for (const action of ["CANCEL_RUN", "RERUN_RUN"] as const) {
        assert.equal(canConfirmAgentAction("EXECUTOR", action), true);
        assert.equal(canConfirmAgentAction("VIEWER", action), false);
    }
});

test("only a generic confirmation matches the four additional proposal types", () => {
    for (const action of ["CANCEL_RUN", "RERUN_RUN", "PUBLISH_RESOURCE", "VALIDATE_RESOURCE"] as const) {
        assert.equal(agentConfirmation("确认操作！")?.(action), true);
        assert.equal(agentConfirmation(" Confirm action. ")?.(action), true);
        assert.equal(agentConfirmation("confirm run")?.(action), false);
        assert.equal(agentConfirmation("confirm save")?.(action), false);
    }
    assert.equal(agentConfirmation("confirm run")?.("TRIGGER_PLAN"), true);
    assert.equal(agentConfirmation("确认保存草稿")?.("SAVE_RESOURCE_DRAFT"), true);
    assert.equal(agentConfirmation("constructor"), undefined);
});

test("resource draft groups keep edit authority and match explicit save or draft confirmations", () => {
    assert.equal(canConfirmAgentAction("EDITOR", "SAVE_RESOURCE_DRAFTS"), true);
    assert.equal(canConfirmAgentAction("EXECUTOR", "SAVE_RESOURCE_DRAFTS"), false);
    for (const phrase of ["confirm", "确认操作", "confirm save", "确认保存", "confirm draft", "确认保存草稿"]) {
        assert.equal(agentConfirmation(phrase)?.("SAVE_RESOURCE_DRAFTS"), true);
    }
    assert.equal(agentConfirmation("confirm run")?.("SAVE_RESOURCE_DRAFTS"), false);
    assert.equal(agentConfirmation("confirm plan")?.("SAVE_RESOURCE_DRAFTS"), false);
});
