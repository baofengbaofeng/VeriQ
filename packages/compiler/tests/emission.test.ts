import { createHash } from "node:crypto";
import ts from "typescript";
import { expect, it } from "vitest";
import { validateSchema, type ExecutionSnapshotV1 } from "@veriq/contracts";
import {
  compileAssets,
  compileFiles,
  assembleExecution,
  type EngineDistribution,
} from "../src/index.js";
import { snapshot, asset, catalog, rehash, hash, id } from "./helpers.js";
const bytes = (s: string) => new TextEncoder().encode(s);
// Isolated fixture distribution: a real archive payload is supplied by packing tests below;
// these byte-integrity tests make no claim to provide or execute the future production SDK.
export function distribution(): EngineDistribution {
  const archive = bytes("isolated dependency byte fixture");
  const integrity =
    "sha512-" + createHash("sha512").update(archive).digest("base64");
  return {
    engineVersion: "0.1.0",
    runnerSdkVersion: "0.1.0",
    dependencies: [{ name: "@veriq/runner-sdk", version: "0.1.0", integrity }],
    files: { "vendor/sdk.tgz": archive },
    packageJson: bytes(
      JSON.stringify({
        name: "veriq-generated",
        version: "0.1.0",
        private: true,
        type: "module",
        dependencies: { "@veriq/runner-sdk": "file:vendor/sdk.tgz" },
      }),
    ),
    packageLock: bytes(
      JSON.stringify({
        name: "veriq-generated",
        version: "0.1.0",
        lockfileVersion: 3,
        packages: {
          "": {
            name: "veriq-generated",
            version: "0.1.0",
            dependencies: { "@veriq/runner-sdk": "file:vendor/sdk.tgz" },
          },
          "node_modules/@veriq/runner-sdk": {
            version: "0.1.0",
            resolved: "file:vendor/sdk.tgz",
            integrity,
          },
        },
      }),
    ),
  };
}
export function execution(): ExecutionSnapshotV1 {
  return {
    schemaVersion: "1.0",
    workspaceId: id(99),
    runId: id(21),
    caseExecutionId: id(22),
    caseVersionId: id(1),
    assetSourceHash: snapshot().sourceHash,
    environmentVersionId: id(23),
    environment: {
      schemaVersion: "1.0",
      baseURL: "https://example.test",
      apiBaseURL: "https://example.test",
      allowedOrigins: ["https://example.test"],
      locale: "en-US",
      timezone: "UTC",
      roles: [
        {
          roleKey: "reader",
          authAdapterVersionId: id(24),
          secretRef: "business",
          secretVersionId: id(25),
        },
      ],
    },
    roleKey: "reader",
    browser: "chromium",
    variables: {},
    secretVersions: [{ secretRef: "business", versionId: id(25) }],
    namespace: "run-21",
    attemptNo: 1,
  };
}
it("fails closed without actual distribution inputs", () =>
  expect(() => compileAssets(snapshot())).toThrow(
    "ENGINE_DISTRIBUTION_REQUIRED",
  ));
it("emits deterministic exact bytes and strict wire descriptor", () => {
  const first = compileFiles(snapshot(), distribution());
  const second = compileFiles(snapshot(), distribution());
  expect(second).toEqual(first);
  expect(validateSchema("CompiledAssetBundle", first.bundle)).toEqual([]);
  expect(first.bundle.entrypoints).toEqual([
    { caseVersionId: id(1), path: `cases/${id(1)}.test.ts` },
  ]);
  for (const file of first.bundle.files) {
    expect(hash(first.files[file.path]!)).toBe(file.sha256);
    expect(first.files[file.path]!.byteLength).toBe(file.sizeBytes);
  }
  expect(compileAssets(snapshot(), distribution())).toEqual(first.bundle);
  const decoded = new TextDecoder().decode(
    first.files[first.bundle.entrypoints[0]!.path],
  );
  const result = ts.transpileModule(decoded, {
    compilerOptions: {
      module: ts.ModuleKind.NodeNext,
      target: ts.ScriptTarget.ES2023,
    },
    reportDiagnostics: true,
  });
  expect(result.diagnostics).toEqual([]);
});
it("retains source context as a verified file for cold assembly", () => {
  const result = compileFiles(snapshot(), distribution());
  const cold = JSON.parse(JSON.stringify(result.bundle));
  const assembled = assembleExecution(cold, execution(), result.files);
  expect(assembled.entrypoint).toBe(`cases/${id(1)}.test.ts`);
  expect(assembled.snapshot).toEqual(execution());
});
it("rejects file tampering before execution assembly", () => {
  const result = compileFiles(snapshot(), distribution());
  result.files["source/asset-snapshot.json"] = bytes("{}");
  expect(() =>
    assembleExecution(result.bundle, execution(), result.files),
  ).toThrow("FILE_HASH_MISMATCH");
});
it("rejects unknown selected case and workspace mismatch", () => {
  const r = compileFiles(snapshot(), distribution());
  expect(() =>
    assembleExecution(
      r.bundle,
      { ...execution(), caseVersionId: id(55) },
      r.files,
    ),
  ).toThrow("UNKNOWN_SELECTED_CASE");
  expect(() =>
    assembleExecution(
      r.bundle,
      { ...execution(), workspaceId: id(55) },
      r.files,
    ),
  ).toThrow("WORKSPACE_MISMATCH");
});
it("rejects duplicate entry mapping and missing entry files", () => {
  const r = compileFiles(snapshot(), distribution());
  expect(() =>
    assembleExecution(
      {
        ...r.bundle,
        entrypoints: [...r.bundle.entrypoints, ...r.bundle.entrypoints],
      },
      execution(),
      r.files,
    ),
  ).toThrow("DUPLICATE_ENTRYPOINT");
  const bad = structuredClone(r.bundle);
  bad.entrypoints[0]!.path = "missing.ts";
  expect(() => assembleExecution(bad, execution(), r.files)).toThrow(
    "MISSING_ENTRYPOINT_FILE",
  );
});
it("emits a real nonexecuting validation library for initial catalog", () => {
  const s = snapshot();
  s.assets = [catalog()];
  s.entryCaseVersionIds = [];
  s.validationTarget = {
    resourceId: s.assets[0].resourceId,
    versionId: id(2),
    revision: 1,
  };
  const r = compileFiles(rehash(s), distribution());
  expect(r.bundle.validationOnly).toBe(true);
  expect(r.bundle.entrypoints).toEqual([]);
  expect(r.files["validation.ts"]!.byteLength).toBeGreaterThan(0);
  expect(() => assembleExecution(r.bundle, execution(), r.files)).toThrow(
    "VALIDATION_ONLY",
  );
});
it("rejects altered dependency bytes and engine mismatch", () => {
  const d = distribution();
  d.files["vendor/sdk.tgz"] = bytes("tampered");
  expect(() => compileFiles(snapshot(), d)).toThrow(
    "DEPENDENCY_INTEGRITY_MISMATCH",
  );
  expect(() =>
    compileFiles(snapshot(), { ...distribution(), engineVersion: "2.0.0" }),
  ).toThrow("ENGINE_VERSION_MISMATCH");
});
it("rejects file paths escaping the distribution and generated namespaces", () => {
  const d = distribution();
  d.files["../sdk.tgz"] = bytes("bad");
  expect(() => compileFiles(snapshot(), d)).toThrow(
    "INVALID_DISTRIBUTION_PATH",
  );
});
it("detects missing distribution files and inconsistent lock inventory", () => {
  const d = distribution();
  d.files = {};
  expect(() => compileFiles(snapshot(), d)).toThrow("MISSING_DEPENDENCY_FILE");
  const e = distribution();
  e.dependencies = [];
  expect(() => compileFiles(snapshot(), e)).toThrow("LOCK_DEPENDENCY_MISMATCH");
});
it("rejects wrong SDK version and package hooks", () => {
  expect(() =>
    compileFiles(snapshot(), { ...distribution(), runnerSdkVersion: "0.2.0" }),
  ).toThrow("SDK_VERSION_MISMATCH");
  const d = distribution();
  const pkg = JSON.parse(new TextDecoder().decode(d.packageJson));
  pkg.scripts = { postinstall: "echo unsafe" };
  d.packageJson = bytes(JSON.stringify(pkg));
  expect(() => compileFiles(snapshot(), d)).toThrow("INVALID_ENGINE_PACKAGE");
});
it("rejects source mismatch and requires files on descriptor-only assembly", () => {
  const r = compileFiles(snapshot(), distribution());
  expect(() =>
    assembleExecution(
      r.bundle,
      { ...execution(), assetSourceHash: "f".repeat(64) },
      r.files,
    ),
  ).toThrow("SOURCE_HASH_MISMATCH");
  expect(() => assembleExecution(r.bundle, execution())).toThrow(
    "BUNDLE_FILES_REQUIRED",
  );
});
it("rejects unknown environment roles and mismatched secret references", () => {
  const r = compileFiles(snapshot(), distribution());
  const e = execution();
  e.environment.roles[0].roleKey = "other";
  expect(() => assembleExecution(r.bundle, e, r.files)).toThrow("UNKNOWN_ROLE");
  expect(() =>
    assembleExecution(
      r.bundle,
      { ...execution(), secretVersions: [] },
      r.files,
    ),
  ).toThrow("SECRET_VERSION_MISMATCH");
});
it("retains source bytes across removal of CASE validation metadata", () => {
  const s = snapshot();
  s.validationTarget = {
    resourceId: s.assets[0].resourceId,
    versionId: id(1),
    revision: 7,
  };
  expect(compileFiles(s, distribution())).toEqual(
    compileFiles(snapshot(), distribution()),
  );
});
it("does not mutate input and emitted bytes are independent copies", () => {
  const s = snapshot();
  const d = distribution();
  const before = structuredClone(s);
  const r = compileFiles(s, d);
  r.files["vendor/sdk.tgz"]![0] = 0;
  expect(s).toEqual(before);
  expect(d.files["vendor/sdk.tgz"]![0]).not.toBe(0);
});
it("emits a canonical-schema-valid source sidecar for every asset kind", () => {
  const documents = [
    [
      "ELEMENT_CATALOG",
      {
        schemaVersion: "1.0",
        elements: [
          { key: "button", locator: { by: "testId", value: "button" } },
        ],
      },
    ],
    [
      "ASSERTION_TEMPLATE",
      {
        schemaVersion: "1.0",
        assertions: [
          {
            id: "ui",
            type: "ui",
            target: "button",
            operator: "visible",
            expected: true,
            severity: "BLOCK",
            expectedSource: "REQ",
          },
        ],
      },
    ],
    [
      "FLOW",
      { schemaVersion: "1.0", steps: [{ id: "reload", action: "reload" }] },
    ],
    [
      "DATASET",
      {
        schemaVersion: "1.0",
        columns: { name: "string" },
        rows: [{ key: "a", values: { name: "A" } }],
      },
    ],
    [
      "FIXTURE",
      {
        schemaVersion: "1.0",
        prepare: { method: "POST", path: "/" },
        query: { method: "GET", path: "/" },
        cleanup: { method: "DELETE", path: "/" },
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
        ttlSeconds: 3600,
      },
    ],
    ["ENVIRONMENT", execution().environment],
  ] as const;
  for (const [kind, document] of documents) {
    const s = snapshot();
    s.assets = [asset(8, kind, document)];
    s.entryCaseVersionIds = [];
    s.validationTarget = {
      resourceId: s.assets[0].resourceId,
      versionId: id(8),
      revision: 3,
    };
    const result = compileFiles(rehash(s), distribution());
    const context = JSON.parse(
      new TextDecoder().decode(result.files["source/asset-snapshot.json"]),
    );
    expect(validateSchema("AssetSnapshotV1", context), kind).toEqual([]);
  }
  for (const kind of ["CASE", "SUITE"]) {
    const s = snapshot();
    if (kind === "SUITE") {
      s.assets.push(
        asset(8, "SUITE", {
          schemaVersion: "1.0",
          cases: [{ versionId: id(1) }],
        }),
      );
      s.validationTarget = {
        resourceId: s.assets[2]!.resourceId,
        versionId: id(8),
        revision: 2,
      };
    }
    const r = compileFiles(rehash(s), distribution());
    expect(
      validateSchema(
        "AssetSnapshotV1",
        JSON.parse(
          new TextDecoder().decode(r.files["source/asset-snapshot.json"]),
        ),
      ),
    ).toEqual([]);
    const e = execution();
    e.assetSourceHash = s.sourceHash;
    expect(assembleExecution(r.bundle, e, r.files).entrypoint).toBe(
      r.bundle.entrypoints[0]!.path,
    );
  }
});
it("rejects ambiguous matching suite roots after removal of validation metadata", () => {
  const s = snapshot();
  s.assets.push(
    asset(8, "SUITE", { schemaVersion: "1.0", cases: [{ versionId: id(1) }] }),
    asset(9, "SUITE", { schemaVersion: "1.0", cases: [{ versionId: id(1) }] }),
  );
  expect(() => compileFiles(rehash(s), distribution())).toThrow(
    "AMBIGUOUS_SUITE_ROOT",
  );
});
it("rejects a lockfile whose transitive dependencies are missing", () => {
  const d = distribution();
  const lock = JSON.parse(new TextDecoder().decode(d.packageLock));
  lock.packages["node_modules/@veriq/runner-sdk"].dependencies = {
    missing: "1.0.0",
  };
  d.packageLock = bytes(JSON.stringify(lock));
  expect(() => compileFiles(snapshot(), d)).toThrow(
    "INCOMPLETE_DEPENDENCY_CLOSURE",
  );
});
it("rechecks descriptor SDK/inventory against retained package bytes", () => {
  const r = compileFiles(snapshot(), distribution());
  expect(() =>
    assembleExecution(
      { ...r.bundle, runnerSdkVersion: "0.2.0" },
      execution(),
      r.files,
    ),
  ).toThrow("SDK_VERSION_MISMATCH");
});
it("rejects unauthorized execution origins and duplicate secret bindings", () => {
  const r = compileFiles(snapshot(), distribution());
  const e = execution();
  e.environment.apiBaseURL = "https://other.test";
  expect(() => assembleExecution(r.bundle, e, r.files)).toThrow(
    "UNAUTHORIZED_ORIGIN",
  );
  const other = execution();
  other.secretVersions.push({ ...other.secretVersions[0]! });
  expect(() => assembleExecution(r.bundle, other, r.files)).toThrow(
    "DUPLICATE_SECRET_REFERENCE",
  );
});
it("checks the selected frozen data row and permits a suite role/browser variant", () => {
  const s = snapshot(
    undefined,
    [
      asset(3, "DATASET", {
        schemaVersion: "1.0",
        columns: { name: "string" },
        rows: [{ key: "a", values: { name: "A" } }],
      }),
    ],
    { datasetVersionId: id(3) },
  );
  const r = compileFiles(s, distribution());
  const e = execution();
  e.assetSourceHash = s.sourceHash;
  expect(() => assembleExecution(r.bundle, e, r.files)).toThrow(
    "DATA_ROW_MISMATCH",
  );
  e.dataRow = { key: "a", values: { name: "A" } };
  expect(assembleExecution(r.bundle, e, r.files).snapshot.dataRow).toEqual(
    e.dataRow,
  );
  s.assets.push(
    asset(8, "SUITE", {
      schemaVersion: "1.0",
      cases: [
        { versionId: id(1), roleKeys: ["editor"], browsers: ["firefox"] },
      ],
    }),
  );
  s.validationTarget = {
    resourceId: s.assets[3]!.resourceId,
    versionId: id(8),
    revision: 1,
  };
  rehash(s);
  const suite = compileFiles(s, distribution());
  e.assetSourceHash = s.sourceHash;
  e.roleKey = "editor";
  e.environment.roles[0].roleKey = "editor";
  e.browser = "firefox";
  expect(assembleExecution(suite.bundle, e, suite.files).snapshot.roleKey).toBe(
    "editor",
  );
});
it("shares one source context module across multiple case entrypoints", () => {
  const s = snapshot();
  const second = structuredClone(s.assets[0]);
  second.resourceId = id(110);
  second.versionId = id(10);
  s.assets.push(second);
  s.entryCaseVersionIds.push(id(10));
  const r = compileFiles(rehash(s), distribution());
  expect(r.files["source/context.ts"]).toBeDefined();
  for (const entry of r.bundle.entrypoints) {
    const syntax = ts.createSourceFile(
      entry.path,
      new TextDecoder().decode(r.files[entry.path]),
      ts.ScriptTarget.ES2023,
      true,
    );
    const imports = syntax.statements
      .filter(ts.isImportDeclaration)
      .map((n) => (n.moduleSpecifier as ts.StringLiteral).text);
    expect(imports).toContain("../source/context.js");
  }
  expect(
    r.bundle.files.filter((f) => f.path === "source/context.ts"),
  ).toHaveLength(1);
});
it("rejects a case-to-file mapping swapped between valid manifested files", () => {
  const s = snapshot();
  const second = structuredClone(s.assets[0]);
  second.resourceId = id(110);
  second.versionId = id(10);
  s.assets.push(second);
  s.entryCaseVersionIds.push(id(10));
  const r = compileFiles(rehash(s), distribution());
  [r.bundle.entrypoints[0]!.path, r.bundle.entrypoints[1]!.path] = [
    r.bundle.entrypoints[1]!.path,
    r.bundle.entrypoints[0]!.path,
  ];
  const e = execution();
  e.assetSourceHash = s.sourceHash;
  expect(() => assembleExecution(r.bundle, e, r.files)).toThrow(
    "ENTRYPOINT_MAPPING_MISMATCH",
  );
});
it("rejects portable filename collisions while compiling", () => {
  const d = distribution();
  d.files["vendor/SDK.tgz"] = d.files["vendor/sdk.tgz"]!.slice();
  const integrity = d.dependencies[0]!.integrity;
  d.dependencies.push({ name: "helper", version: "0.1.0", integrity });
  const lock = JSON.parse(new TextDecoder().decode(d.packageLock));
  lock.packages["node_modules/helper"] = {
    version: "0.1.0",
    resolved: "file:vendor/SDK.tgz",
    integrity,
  };
  lock.packages["node_modules/@veriq/runner-sdk"].dependencies = {
    helper: "0.1.0",
  };
  d.packageLock = bytes(JSON.stringify(lock));
  expect(() => compileFiles(snapshot(), d)).toThrow("DUPLICATE_FILE_PATH");
});
