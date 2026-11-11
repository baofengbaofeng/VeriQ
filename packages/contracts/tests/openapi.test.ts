import SwaggerParser from "@apidevtools/swagger-parser";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

test("OpenAPI resolves and validates actual core requests and responses", async () => {
  const api = await SwaggerParser.validate(fileURLToPath(new URL("../openapi/platform.yaml", import.meta.url)));
  expect("openapi" in api && api.openapi).toBe("3.1.0");
  const claim = api.paths!["/internal/v1/runtimes/claim"]!.post!;
  expect(claim.responses).toHaveProperty("204");
  expect(claim.responses).toHaveProperty("200");
  expect(claim.security).toEqual([{DeviceToken: []}]);
  const trigger = api.paths!["/api/v1/workspaces/{workspaceId}/execution-plans/{planId}/trigger"]!.post!;
  expect(trigger.parameters).toContainEqual(expect.objectContaining({name:"Idempotency-Key", required:true}));
  const draft = api.paths!["/api/v1/workspaces/{workspaceId}/resources/{resourceId}/draft"]!.put!;
  expect(draft.responses).toHaveProperty("409");
});

test("external maintenance uses canonical internal paths and scoped service tokens", async () => {
  const api = await SwaggerParser.validate(fileURLToPath(new URL("../openapi/platform.yaml", import.meta.url)));
  for (const suffix of ["expired-leases/reap", "fixture-cleanups/reconcile", "artifacts/expire", "capacity/reconcile"]) {
    const operation = api.paths![`/internal/v1/maintenance/${suffix}`]?.post;
    expect(operation).toBeDefined();
    expect(operation!.security).toEqual([{ServiceToken: []}]);
    expect(operation!.parameters).toContainEqual(expect.objectContaining({name:"Idempotency-Key",required:true}));
  }
});

test("validation receipts are retrievable through authorized job results", async () => {
  const api = await SwaggerParser.validate(fileURLToPath(new URL("../openapi/platform.yaml", import.meta.url)));
  const operation = api.paths!["/api/v1/workspaces/{workspaceId}/jobs/{jobId}/validation-receipt"]?.get;
  expect(operation).toBeDefined();
  // T04 implements session-authorized receipt reads; automation auth is a later task.
  expect(operation!.security).toEqual([{WebSession:[],CsrfToken:[]}]);
  expect(operation!.responses).toHaveProperty("200");
  expect(operation!.responses).toHaveProperty("409");
  expect(operation!.parameters).toEqual(expect.arrayContaining([
    expect.objectContaining({name:"workspaceId",in:"path",required:true}),
    expect.objectContaining({name:"jobId",in:"path",required:true}),
  ]));
});

test("content-addressed device downloads require attempt, Workspace and current lease proof", async () => {
  const api = await SwaggerParser.validate(fileURLToPath(new URL("../openapi/platform.yaml", import.meta.url)));
  const operation = api.paths!["/internal/v1/workspaces/{workspaceId}/attempts/{attemptId}/content/{sha256}"]?.get;
  expect(operation).toBeDefined();
  expect(operation!.security).toEqual([{DeviceToken:[]}]);
  expect(operation!.parameters).toEqual(expect.arrayContaining([
    ...["workspaceId","attemptId","sha256"].map(name => expect.objectContaining({name,in:"path",required:true})),
    ...["X-VeriQ-Lease-Token","X-VeriQ-Fencing-Token"].map(name => expect.objectContaining({name,in:"header",required:true})),
  ]));
  for (const code of ["200","401","403","404","409"]) expect(operation!.responses).toHaveProperty(code);
  expect(api.paths).not.toHaveProperty("/internal/v1/snapshots/{snapshotId}");
});
