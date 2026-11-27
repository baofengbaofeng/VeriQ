import assert from "node:assert/strict";
import test from "node:test";
import { agentFormRequestHeader, inheritAgentFormSignal, scopeAgentFormSignal } from "../../src/agent-form-origin";

const id = "cdf6611f-8de6-4ad4-aedc-a622296a06ef";
const workspace = `/workspaces/${id}`;
const resource = `${workspace}/resources/${id}`;

test("form attribution follows an explicitly scoped request, not parallel work from the same parent", () => {
    const parent = new AbortController();
    const scoped = scopeAgentFormSignal(parent.signal, id, "FIXTURE");
    const child = inheritAgentFormSignal(AbortSignal.any([scoped]), scoped);
    assert.deepEqual(agentFormRequestHeader(`${resource}/draft`, "PUT", child), { "X-VeriQ-Agent-Form": id });
    assert.deepEqual(agentFormRequestHeader(`${resource}/draft`, "PUT", parent.signal), {});
    assert.deepEqual(agentFormRequestHeader(`${resource}/draft`, "PUT"), {});
    assert.deepEqual(agentFormRequestHeader(resource, "GET", scoped), {});
    assert.deepEqual(agentFormRequestHeader(`${resource}/validation-preview`, "POST", scoped), {});
    assert.deepEqual(agentFormRequestHeader(workspace, "DELETE", scoped), {});
    parent.abort();
    assert.equal(child.aborted, true);
});

test("device delivery, invitations and CI writes only receive the header inside the matching capability", () => {
    const signal = new AbortController().signal;
    const grants = `${workspace}/runtimes/${id}/grants`;
    const delivery = `${workspace}/runtimes/${id}/credential-delivery`;
    const ci = `${workspace}/service-accounts/${id}/tokens`;
    const access = scopeAgentFormSignal(signal, id, "DEVICE_ACCESS");
    const credentials = scopeAgentFormSignal(signal, id, "DEVICE_CREDENTIAL_DELIVERY");
    const members = scopeAgentFormSignal(signal, id, "WORKSPACE_MEMBERS");
    const tokens = scopeAgentFormSignal(signal, id, "CI_PLAN_TOKENS");
    const expected = { "X-VeriQ-Agent-Form": id };
    assert.deepEqual(agentFormRequestHeader(grants, "PUT", access), expected);
    assert.deepEqual(agentFormRequestHeader(delivery, "PUT", access), {});
    assert.deepEqual(agentFormRequestHeader(delivery, "PUT", credentials), expected);
    assert.deepEqual(agentFormRequestHeader(grants, "PUT", credentials), {});
    assert.deepEqual(agentFormRequestHeader(`${workspace}/invitations`, "POST", members), expected);
    assert.deepEqual(agentFormRequestHeader(ci, "POST", members), {});
    assert.deepEqual(agentFormRequestHeader(ci, "POST", tokens), expected);
});
