import assert from "node:assert/strict";
import test from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { resolveOperation } from "../src/main/policy.ts";
import desktopSchema from "../src/shared/validation.generated.json" with { type: "json" };

import httpDataset from "../../../packages/contracts/fixtures/http-dataset.json" with { type: "json" };
import datasetFixtures from "../../../packages/contracts/fixtures/datasets.json" with { type: "json" };

const validator = new Ajv2020({ strict: true, allErrors: true });
addFormats.default(validator);
validator.addSchema(desktopSchema);

/**
 * 正常登录与资源查询必须映射到宿主拥有的固定路径，本组断言同时证明白名单提供实际业务能力，避免全部拒绝的空实现被当成通
 * 过安全验收的实现。
 */
test("login maps to its fixed ordinary-session route", () => {
    const result = resolveOperation(
        { operation: "login", data: { email: "test@example.com", password: "Password 123!" } },
        undefined,
    );
    assert.deepEqual(result, {
        path: "/api/v1/auth/login",
        method: "POST",
        data: { email: "test@example.com", password: "Password 123!" },
        kind: "json",
    });
});

test("resource reads bind the selected workspace", () => {
    const workspaceId = "00000000-0000-4000-8000-000000000001";
    const result = resolveOperation(
        { operation: "listResources", params: { workspaceId }, query: { kind: "CASE" } },
        workspaceId,
    );
    assert.deepEqual(result, {
        path: `/api/v1/workspaces/${workspaceId}/resources?kind=CASE`,
        method: "GET",
        kind: "json",
    });
});

/**
 * 来自渲染进程的同形恶意输入不得突破固定业务操作集合，未知字段和跨工作区请求均必须在网络发送前失败，而不是交给远端错误
 * 偶然阻止越权。
 */
test("arbitrary transport fields and device-token operations are rejected", () => {
    for (const value of [
        { operation: "fetch", url: "https://evil.example" },
        { operation: "login", data: {}, headers: { Authorization: "Bearer forbidden" } },
        { operation: "pollEnrollment", data: { deviceCode: "secret" } },
        { operation: "session", path: "/internal/v1/runtime" },
    ])
        assert.throws(() => resolveOperation(value, undefined), /IPC_OPERATION_DENIED|IPC_PAYLOAD_INVALID/);
});

test("connected desktop has no bundle export capability", () => {
    assert.throws(() => resolveOperation({ operation: "createBundle" }, undefined), /IPC_OPERATION_DENIED/);
});

test("foreign workspace is rejected before a resource request", () => {
    assert.throws(
        () =>
            resolveOperation(
                {
                    operation: "listResources",
                    params: { workspaceId: "00000000-0000-4000-8000-000000000002" },
                },
                "00000000-0000-4000-8000-000000000001",
            ),
        /WORKSPACE_SCOPE_MISMATCH/,
    );
});

/**
 * 桌面派生 DSL 校验应接受被测系统的 veriqId 定位器，并拒绝旧的 testId 拼写，确保定位语义来自当前权威定义。
 */
test("generated locator accepts veriqId and rejects the retired testId spelling", () => {
    const validate = validator.getSchema(`${desktopSchema.$id}#/$defs/LocatorV1`);
    assert.ok(validate);
    assert.equal(validate({ by: "veriqId", value: "checkout-submit" }), true);
    assert.equal(validate({ by: "testId", value: "checkout-submit" }), false);
});

/**
 * 通过桌面白名单里的真实草稿操作验证数据集信封，合法表格通过，树形元数据不全的正文在发送网络请求之前被拒绝。
 */
test("desktop draft writes apply the V2 dataset schema", () => {
    const workspaceId = "00000000-0000-4000-8000-000000000001";
    const resourceId = "00000000-0000-4000-8000-000000000002";
    for (const fixture of datasetFixtures) {
        const data = { revision: 1, content: { kind: "DATASET", document: fixture.document } };
        const request = { operation: "updateDraft", params: { workspaceId, resourceId }, data };
        if (fixture.invalidStructure)
            assert.throws(() => resolveOperation(request, workspaceId), /IPC_PAYLOAD_INVALID/, fixture.name);
        else assert.deepEqual(resolveOperation(request, workspaceId).data, data, fixture.name);
    }
});

/**
 * 维护令牌元数据应保留五项合法操作组成的当前清单，同时继续拒绝重复项和超出已批准容量的列表。
 */
test("generated maintenance token metadata admits the five allowed scopes", () => {
    const validate = validator.getSchema(`${desktopSchema.$id}#/$defs/api_ServiceTokenMetadata`);
    assert.ok(validate);
    const operations = [
        "expired-leases/reap",
        "fixture-cleanups/reconcile",
        "capacity/reconcile",
        "artifacts/expire",
        "lifecycle/expire",
    ];
    const token = {
        id: "00000000-0000-4000-8000-000000000001",
        purpose: "MAINTENANCE",
        operations,
        planIds: [],
        expiresAt: "2026-11-18T00:00:00Z",
        revoked: false,
        consumed: false,
    };
    assert.equal(validate(token), true);
    assert.equal(validate({ ...token, operations: [...operations.slice(0, 4), operations[0]] }), false);
    assert.ok(validate.errors?.some(({ keyword }) => keyword === "uniqueItems"));
    assert.equal(validate({ ...token, operations: [...operations, "extra-scope"] }), false);
    assert.ok(validate.errors?.some(({ keyword }) => keyword === "maxItems"));
});

test("dataset copy discovery and creation bind the selected target workspace", () => {
    const workspaceId = "00000000-0000-4000-8000-000000000001";
    const sourceWorkspaceId = "00000000-0000-4000-8000-000000000002";
    const data = { sourceWorkspaceId, sourceDatasetVersionId: workspaceId, key: "copy", name: "copy" };
    const params = { workspaceId };
    const query = { sourceWorkspaceId };
    const path = `/api/v1/workspaces/${workspaceId}/resources/dataset-copies`;
    const list = { operation: "listDatasetCopySources", params, query };
    const copy = { operation: "copyDataset", params, data };
    assert.equal(resolveOperation(list, workspaceId).path, path + "?sourceWorkspaceId=" + sourceWorkspaceId);
    assert.deepEqual(resolveOperation(copy, workspaceId), { method: "POST", path, data, kind: "json" });
    for (const request of [list, copy]) {
        assert.throws(() => resolveOperation(request, sourceWorkspaceId), /WORKSPACE_SCOPE_MISMATCH/);
    }
});

test("HTTP dataset previews stay within the selected workspace and reject credential material", () => {
    const workspaceId = "00000000-0000-4000-8000-000000000001";
    const resourceId = "00000000-0000-4000-8000-000000000002";
    const item = {
        operation: "previewHttpDataset",
        params: { workspaceId, resourceId },
        data: { document: httpDataset, arguments: {} },
    };
    assert.equal(
        resolveOperation(item, workspaceId).path,
        `/api/v1/workspaces/${workspaceId}/resources/${resourceId}/http-preview`,
    );
    assert.throws(() => resolveOperation(item, resourceId), /WORKSPACE_SCOPE_MISMATCH/);
    const bad = { ...httpDataset, source: { ...httpDataset.source, auth: { kind: "BEARER", value: "fixture" } } };
    assert.throws(() => resolveOperation({ ...item, data: { document: bad, arguments: {} } }, workspaceId));
});

test("updateDraft accepts CASE HTTP source arguments with a bound value", () => {
    const workspaceId = "00000000-0000-4000-8000-000000000001";
    const resourceId = "00000000-0000-4000-8000-000000000002";
    const query = { alias: "remote", op: "field", key: "one", field: "label", parameters: { search: "{{data.name}}" } };
    const data = {
        revision: 1,
        content: {
            kind: "CASE",
            document: {
                schemaVersion: "1.0",
                caseKey: "lookup",
                title: "Lookup",
                kind: "READ",
                roleKey: "reader",
                catalogVersionId: resourceId,
                datasetBindings: { remote: resourceId },
                steps: [
                    {
                        id: "home",
                        action: "goto",
                        path: "/",
                        afterAssertions: [
                            {
                                id: "match",
                                type: "url",
                                source: "page",
                                operator: "contains",
                                severity: "WARN",
                                expectedSource: "catalog",
                                datasetExpected: query,
                            },
                        ],
                    },
                ],
            },
        },
    };
    assert.deepEqual(
        resolveOperation({ operation: "updateDraft", params: { workspaceId, resourceId }, data }, workspaceId).data,
        data,
    );
});
