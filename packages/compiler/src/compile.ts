import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { createHash } from "node:crypto";
import ts from "typescript";
import {
  assetSourceBytes,
  canonicalBytes,
  resolveBinding,
  resolveInitialVariables,
  validateSchema,
  type AssetSnapshotV1,
  type CompiledAssetBundle,
  type DependencyVersion,
  type ExecutionSnapshotV1,
  type FileEntry,
  type CompiledStep,
} from "@veriq/contracts";
import { analyze, validate, type CompiledCase } from "./validate.js";
import { sha256 } from "./dependency.js";
export const COMPILER_VERSION = "0.1.0";
export const SOURCE_SNAPSHOT_PATH = "source/asset-snapshot.json";
export interface EngineDistribution {
  engineVersion: string;
  runnerSdkVersion: string;
  /** Exact installable distribution package and npm v3 lock bytes, supplied by the engine release. */
  packageJson: Uint8Array;
  packageLock: Uint8Array;
  /** Complete pinned dependency inventory, including transitives. */
  dependencies: DependencyVersion[];
  /** Offline npm archives referenced by the lock; only vendor/ paths are accepted. */
  files: Record<string, Uint8Array>;
}
export interface CompiledOutput {
  bundle: CompiledAssetBundle;
  files: Record<string, Uint8Array>;
}
export interface ExecutionPackage {
  bundle: CompiledAssetBundle;
  files: Record<string, Uint8Array>;
  entrypoint: string;
  snapshot: ExecutionSnapshotV1;
}
/** T06 implements this import's ABI. Execution context is injected by the worker, never emitted. */
export interface RunnerSdkV1 {
  registerCase(plan: CompiledCase, source: AssetSnapshotV1): void;
}
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
function parse(bytes: Uint8Array): Record<string, unknown> {
  return JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  ) as Record<string, unknown>;
}
function checkSchema(name: string, value: unknown): void {
  const errors = validateSchema(name, value);
  if (errors.length)
    throw new Error(`INVALID_${name}: ${JSON.stringify(errors)}`);
}
const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
function distributionFiles(
  d: EngineDistribution | undefined,
  engine: string,
): Record<string, Uint8Array> {
  if (!d) throw new Error("ENGINE_DISTRIBUTION_REQUIRED");
  if (d.engineVersion !== engine) throw new Error("ENGINE_VERSION_MISMATCH");
  const files: Record<string, Uint8Array> = Object.create(null) as Record<
    string,
    Uint8Array
  >;
  for (const [path, content] of Object.entries(d.files)) {
    if (
      !path.startsWith("vendor/") ||
      validateSchema("FilePath", path).length ||
      path.split("/").some((x) => !x || x === ".") ||
      !(content instanceof Uint8Array)
    )
      throw new Error("INVALID_DISTRIBUTION_PATH");
    files[path] = content.slice();
  }
  const pkg = parse(d.packageJson);
  const lock = parse(d.packageLock);
  if (
    pkg.type !== "module" ||
    pkg.scripts !== undefined ||
    pkg.devDependencies !== undefined ||
    pkg.optionalDependencies !== undefined ||
    lock.lockfileVersion !== 3 ||
    !record(pkg.dependencies) ||
    !record(lock.packages) ||
    !record(lock.packages[""])
  )
    throw new Error("INVALID_ENGINE_PACKAGE");
  if (
    sha256(canonicalBytes(pkg.dependencies)) !==
    sha256(canonicalBytes(lock.packages[""].dependencies))
  )
    throw new Error("LOCK_ROOT_MISMATCH");
  const sdk = lock.packages["node_modules/@veriq/runner-sdk"];
  if (
    !Object.hasOwn(pkg.dependencies, "@veriq/runner-sdk") ||
    !record(sdk) ||
    sdk.version !== d.runnerSdkVersion
  )
    throw new Error("SDK_VERSION_MISMATCH");
  const inventory = new Map<string, DependencyVersion>();
  for (const dependency of d.dependencies) {
    checkSchema("DependencyVersion", dependency);
    const key = dependency.name + "@" + dependency.version;
    if (inventory.has(key)) throw new Error("DUPLICATE_DEPENDENCY");
    inventory.set(key, dependency);
  }
  const used = new Set<string>();
  const usedFiles = new Set<string>();
  for (const [location, node] of Object.entries(lock.packages)) {
    if (location === "") continue;
    if (
      !/^node_modules\/(?:@[^/]+\/)?[^/]+(?:\/node_modules\/(?:@[^/]+\/)?[^/]+)*$/u.test(
        location,
      ) ||
      !record(node) ||
      node.link ||
      node.hasInstallScript
    )
      throw new Error("INVALID_LOCK_PACKAGE");
    const name = location.slice(
      location.lastIndexOf("node_modules/") + "node_modules/".length,
    );
    const key = name + "@" + String(node.version);
    const dep = inventory.get(key);
    if (
      !dep ||
      dep.integrity !== node.integrity ||
      typeof node.resolved !== "string" ||
      !node.resolved.startsWith("file:vendor/")
    )
      throw new Error("LOCK_DEPENDENCY_MISMATCH");
    const path = node.resolved.slice(5);
    const content = files[path];
    if (!content) throw new Error("MISSING_DEPENDENCY_FILE");
    if (
      dep.integrity !==
      "sha512-" + createHash("sha512").update(content).digest("base64")
    )
      throw new Error("DEPENDENCY_INTEGRITY_MISMATCH");
    for (const name of Object.keys(
      record(node.dependencies) ? node.dependencies : {},
    )) {
      let parent = location;
      let found = false;
      while (true) {
        if (Object.hasOwn(lock.packages, parent + "/node_modules/" + name)) {
          found = true;
          break;
        }
        const boundary = parent.lastIndexOf("/node_modules/");
        if (boundary < 0) {
          found = Object.hasOwn(lock.packages, "node_modules/" + name);
          break;
        }
        parent = parent.slice(0, boundary);
      }
      if (!found) throw new Error("INCOMPLETE_DEPENDENCY_CLOSURE");
    }
    used.add(key);
    usedFiles.add(path);
  }
  if (
    used.size !== inventory.size ||
    usedFiles.size !== Object.keys(files).length
  )
    throw new Error("DEPENDENCY_CLOSURE_MISMATCH");
  for (const [name, resolved] of Object.entries(pkg.dependencies)) {
    const node = lock.packages["node_modules/" + name];
    if (!record(node) || node.resolved !== resolved)
      throw new Error("LOCK_ROOT_MISMATCH");
  }
  files["package.json"] = d.packageJson.slice();
  files["package-lock.json"] = d.packageLock.slice();
  files["dependencies.json"] = canonicalBytes(d.dependencies);
  return files;
}
/** TypeScript's printer handles identifiers/string literal escaping; DSL is emitted as inert JSON data. */
function registration(plan: CompiledCase): Uint8Array {
  const f = ts.factory;
  const json = (v: unknown): ts.Expression =>
    f.createCallExpression(
      f.createPropertyAccessExpression(f.createIdentifier("JSON"), "parse"),
      undefined,
      [f.createStringLiteral(new TextDecoder().decode(canonicalBytes(v)))],
    );
  const contextImport = f.createImportDeclaration(
    undefined,
    f.createImportClause(
      false,
      undefined,
      f.createNamedImports([
        f.createImportSpecifier(false, undefined, f.createIdentifier("source")),
      ]),
    ),
    f.createStringLiteral("../source/context.js"),
  );
  const statements = [
    contextImport,
    f.createImportDeclaration(
      undefined,
      f.createImportClause(
        false,
        undefined,
        f.createNamedImports([
          f.createImportSpecifier(
            false,
            undefined,
            f.createIdentifier("registerCase"),
          ),
        ]),
      ),
      f.createStringLiteral("@veriq/runner-sdk"),
    ),
    f.createExpressionStatement(
      f.createCallExpression(f.createIdentifier("registerCase"), undefined, [
        json(plan),
        f.createIdentifier("source"),
      ]),
    ),
  ];
  const file = f.updateSourceFile(
    ts.createSourceFile(
      "case.test.ts",
      "",
      ts.ScriptTarget.ES2023,
      false,
      ts.ScriptKind.TS,
    ),
    statements,
  );
  return bytes(
    ts.createPrinter({ newLine: ts.NewLineKind.LineFeed }).printFile(file),
  );
}
export function compileFiles(
  snapshot: AssetSnapshotV1,
  distribution?: EngineDistribution,
): CompiledOutput {
  const analysis = analyze(snapshot);
  if (analysis.issues.length)
    throw new Error(
      "ASSET_VALIDATION_FAILED: " + JSON.stringify(analysis.issues),
    );
  const files = distributionFiles(distribution, snapshot.engineVersion);
  const { validationTarget: _target, ...source } = snapshot;
  // Frozen identity projection is also the recoverable Workspace/source context for downloaded bundles.
  files[SOURCE_SNAPSHOT_PATH] = canonicalBytes(
    snapshot.entryCaseVersionIds.length ? source : snapshot,
  );
  if (snapshot.entryCaseVersionIds.length)
    files["source/context.ts"] = bytes(
      "export const source = JSON.parse(" +
        JSON.stringify(new TextDecoder().decode(canonicalBytes(source))) +
        ");\n",
    );
  const entrypoints = snapshot.entryCaseVersionIds.map((caseVersionId) => ({
    caseVersionId,
    path: `cases/${caseVersionId}.test.ts`,
  }));
  for (const entry of entrypoints)
    files[entry.path] = registration(
      analysis.cases.find((c) => c.caseVersionId === entry.caseVersionId)!,
    );
  if (!entrypoints.length)
    files["validation.ts"] = bytes(
      "export const validationOnly = true;\nexport const assets = JSON.parse(" +
        JSON.stringify(
          new TextDecoder().decode(canonicalBytes(source.assets)),
        ) +
        ");\n",
    );
  const expectedCases = analysis.cases.map((plan) => {
    let ordinal = 0;
    const flatten = (steps: CompiledStep[], parentId?: string): Record<string, unknown>[] =>
      steps.flatMap((step) => [{
        id: step.step.id, order: ordinal++, ...(parentId ? { parentId } : {}),
        failurePolicy: step.step.failurePolicy ?? "STOP",
        assertions: [
          ...step.before.map((a) => ({ id: a.assertion.id, severity: a.assertion.severity, stage: a.assertion.type === "requestCount" ? "FINALIZE" : "BEFORE" })),
          ...step.responseAssertions.map((a) => ({ id: a.assertion.id, severity: a.assertion.severity, stage: a.assertion.type === "requestCount" ? "FINALIZE" : "RESPONSE" })),
          ...step.after.map((a) => ({ id: a.assertion.id, severity: a.assertion.severity, stage: a.assertion.type === "requestCount" ? "FINALIZE" : "AFTER" })),
        ],
        observers: (step.step.observers ?? []).map((o) => o.id),
      }, ...flatten(step.children ?? [], step.step.id)]);
    return { caseVersionId: plan.caseVersionId, requiredEvidenceKinds: ["TRACE"], steps: flatten(plan.steps),
      ...(plan.persistenceCheckpointStepId ? { persistenceCheckpointStepId: plan.persistenceCheckpointStepId } : {}) };
  });
  files["metadata/expected-plans.json"] = canonicalBytes({ schemaVersion: "1.0", cases: expectedCases });
  const manifest = Object.keys(files)
    .sort()
    .map((path) => ({
      path,
      sha256: sha256(files[path]!),
      sizeBytes: files[path]!.byteLength,
    }));
  const bundle: CompiledAssetBundle = {
    schemaVersion: "1.0",
    sourceHash: snapshot.sourceHash,
    engineVersion: snapshot.engineVersion,
    compilerVersion: COMPILER_VERSION,
    runnerSdkVersion: distribution!.runnerSdkVersion,
    entrypoints,
    files: manifest as [FileEntry, ...FileEntry[]],
    dependencies: structuredClone(distribution!.dependencies) as [
      DependencyVersion,
      ...DependencyVersion[],
    ],
    ...(!entrypoints.length ? { validationOnly: true } : {}),
  };
  verifyFiles(bundle, files);
  return { bundle, files };
}
/** Descriptor-only compatibility API. Use compileFiles for upload/export; no hidden file cache. */
export function compileAssets(
  snapshot: AssetSnapshotV1,
  distribution?: EngineDistribution,
): CompiledAssetBundle {
  return compileFiles(snapshot, distribution).bundle;
}
export function verifyFiles(
  bundle: CompiledAssetBundle,
  files: Record<string, Uint8Array>,
): void {
  checkSchema("CompiledAssetBundle", bundle);
  const seen = new Set<string>();
  const folded = new Set<string>();
  for (const file of bundle.files) {
    const key = file.path.normalize("NFC").toLowerCase();
    if (seen.has(file.path) || folded.has(key))
      throw new Error("DUPLICATE_FILE_PATH");
    seen.add(file.path);
    folded.add(key);
    if (
      file.path.split("/").some((x) => x === "" || x === ".") ||
      !Object.hasOwn(files, file.path)
    )
      throw new Error("MISSING_BUNDLE_FILE");
    const content = files[file.path]!;
    if (
      content.byteLength !== file.sizeBytes ||
      sha256(content) !== file.sha256
    )
      throw new Error("FILE_HASH_MISMATCH");
  }
  if (Object.keys(files).length !== seen.size)
    throw new Error("UNMANIFESTED_FILE");
}
/** Cold assembly accepts downloaded descriptor + exact files. No process-local identity registry. */
export function assembleExecution(
  bundle: CompiledAssetBundle,
  snapshot: ExecutionSnapshotV1,
  files?: Record<string, Uint8Array>,
): ExecutionPackage {
  checkSchema("CompiledAssetBundle", bundle);
  checkSchema("ExecutionSnapshotV1", snapshot);
  if (bundle.validationOnly) throw new Error("VALIDATION_ONLY");
  if (!files) throw new Error("BUNDLE_FILES_REQUIRED");
  verifyFiles(bundle, files);
  const entries = new Set<string>();
  const paths = new Set<string>();
  for (const entry of bundle.entrypoints) {
    if (entries.has(entry.caseVersionId) || paths.has(entry.path))
      throw new Error("DUPLICATE_ENTRYPOINT");
    entries.add(entry.caseVersionId);
    paths.add(entry.path);
    if (!Object.hasOwn(files, entry.path))
      throw new Error("MISSING_ENTRYPOINT_FILE");
    if (entry.path !== `cases/${entry.caseVersionId}.test.ts`)
      throw new Error("ENTRYPOINT_MAPPING_MISMATCH");
  }
  const selected = bundle.entrypoints.find(
    (e) => e.caseVersionId === snapshot.caseVersionId,
  );
  if (!selected) throw new Error("UNKNOWN_SELECTED_CASE");
  const raw = files[SOURCE_SNAPSHOT_PATH];
  if (!raw) throw new Error("SOURCE_CONTEXT_REQUIRED");
  const source = parse(raw) as AssetSnapshotV1;
  const problems = validate(source);
  if (problems.length)
    throw new Error("INVALID_SOURCE_CONTEXT: " + JSON.stringify(problems));
  if (source.workspaceId !== snapshot.workspaceId)
    throw new Error("WORKSPACE_MISMATCH");
  if (
    sha256(assetSourceBytes(source)) !== bundle.sourceHash ||
    snapshot.assetSourceHash !== bundle.sourceHash
  )
    throw new Error("SOURCE_HASH_MISMATCH");
  if (source.engineVersion !== bundle.engineVersion)
    throw new Error("ENGINE_VERSION_MISMATCH");
  if (!files["package.json"] || !files["package-lock.json"])
    throw new Error("MISSING_ENGINE_FILES");
  const vendorFiles = Object.fromEntries(
    Object.entries(files).filter(([path]) => path.startsWith("vendor/")),
  );
  distributionFiles(
    {
      engineVersion: bundle.engineVersion,
      runnerSdkVersion: bundle.runnerSdkVersion,
      dependencies: bundle.dependencies,
      packageJson: files["package.json"]!,
      packageLock: files["package-lock.json"]!,
      files: vendorFiles,
    },
    source.engineVersion,
  );
  if (
    !files["dependencies.json"] ||
    sha256(files["dependencies.json"]) !==
      sha256(canonicalBytes(bundle.dependencies))
  )
    throw new Error("DEPENDENCY_INVENTORY_MISMATCH");
  if (
    source.entryCaseVersionIds.length !== entries.size ||
    source.entryCaseVersionIds.some((id) => !entries.has(id))
  )
    throw new Error("ENTRYPOINT_SOURCE_MISMATCH");
  const selectedCase = source.assets.find(
    (a) => a.versionId === snapshot.caseVersionId,
  );
  if (selectedCase?.kind !== "CASE") throw new Error("UNKNOWN_SELECTED_CASE");
  const suite = source.assets.find((a) => a.kind === "SUITE");
  const variants =
    suite?.kind === "SUITE"
      ? suite.document.cases.filter(
          (c) =>
            c.versionId === snapshot.caseVersionId &&
            (c.roleKeys ?? [selectedCase.document.roleKey]).includes(
              snapshot.roleKey,
            ) &&
            (!c.browsers || c.browsers.includes(snapshot.browser)),
        )
      : [
          {
            versionId: snapshot.caseVersionId,
            ...(selectedCase.document.datasetVersionId
              ? { datasetVersionId: selectedCase.document.datasetVersionId }
              : {}),
          },
        ];
  if (
    suite
      ? variants.length === 0
      : selectedCase.document.roleKey !== snapshot.roleKey
  )
    throw new Error("ROLE_MISMATCH");
  // A no-data alternative remains distinct from every dataset alternative.
  // Role/browser filtering above must stay coupled to this exact row match.
  const matchesData = variants.some((variant) => {
    const datasetId =
      variant.datasetVersionId ?? selectedCase.document.datasetVersionId;
    if (!datasetId) return snapshot.dataRow === undefined;
    if (!snapshot.dataRow) return false;
    const dataset = source.assets.find((a) => a.versionId === datasetId);
    return (
      dataset?.kind === "DATASET" &&
      dataset.document.rows.some(
        (row) =>
          sha256(canonicalBytes(row)) ===
          sha256(canonicalBytes(snapshot.dataRow)),
      )
    );
  });
  if (!matchesData)
    throw new Error(
      variants.some(
        (c) => c.datasetVersionId ?? selectedCase.document.datasetVersionId,
      )
        ? "DATA_ROW_MISMATCH"
        : "UNEXPECTED_DATA_ROW",
    );
  const initialVariables = resolveInitialVariables(
    selectedCase.document.initialVariables,
    snapshot.variables,
  );
  if (selectedCase.document.fixtureVersionId) {
    const fixture = source.assets.find(
      (a) => a.versionId === selectedCase.document.fixtureVersionId,
    );
    if (fixture?.kind !== "FIXTURE") throw new Error("FIXTURE_REQUIRED");
    const schemas = new Ajv2020({ strict: false, allErrors: true });
    addFormats.default(schemas);
    const input = resolveBinding(selectedCase.document.fixtureInput ?? {}, {
      data: snapshot.dataRow?.values ?? {},
      vars: initialVariables,
    });
    if (!schemas.compile(fixture.document.inputSchema)(input))
      throw new Error("FIXTURE_INPUT_INVALID");
  }
  const origins = new Set(snapshot.environment.allowedOrigins);
  for (const base of [
    snapshot.environment.baseURL,
    snapshot.environment.apiBaseURL,
    snapshot.environment.fixtureBaseURL,
  ].filter((v): v is string => !!v))
    if (!origins.has(new URL(base).origin))
      throw new Error("UNAUTHORIZED_ORIGIN");
  if (
    new Set(snapshot.environment.roles.map((r) => r.roleKey)).size !==
    snapshot.environment.roles.length
  )
    throw new Error("DUPLICATE_ROLE");
  if (
    new Set(snapshot.secretVersions.map((s) => s.secretRef)).size !==
    snapshot.secretVersions.length
  )
    throw new Error("DUPLICATE_SECRET_REFERENCE");
  const role = snapshot.environment.roles.find(
    (r) => r.roleKey === snapshot.roleKey,
  );
  if (!role) throw new Error("UNKNOWN_ROLE");
  if (
    !snapshot.secretVersions.some(
      (s) =>
        s.secretRef === role.secretRef && s.versionId === role.secretVersionId,
    )
  )
    throw new Error("SECRET_VERSION_MISMATCH");
  const identities = [
    role,
    ...(selectedCase.document.fixtureVersionId &&
    snapshot.environment.fixtureIdentity
      ? [snapshot.environment.fixtureIdentity]
      : []),
  ];
  if (
    selectedCase.document.fixtureVersionId &&
    !snapshot.environment.fixtureIdentity
  )
    throw new Error("FIXTURE_IDENTITY_REQUIRED");
  const expectedAdapters = new Set(
    identities.map((r) => r.authAdapterVersionId),
  );
  const adapters = snapshot.authAdapters ?? [];
  if (new Set(adapters.map((a) => a.versionId)).size !== adapters.length)
    throw new Error("DUPLICATE_AUTH_ADAPTER");
  for (const identity of identities) {
    if (!adapters.some((a) => a.versionId === identity.authAdapterVersionId))
      throw new Error("AUTH_ADAPTER_REQUIRED");
    if (
      !snapshot.secretVersions.some(
        (s) =>
          s.secretRef === identity.secretRef &&
          s.versionId === identity.secretVersionId,
      )
    )
      throw new Error("SECRET_VERSION_MISMATCH");
  }
  if (
    snapshot.secretVersions.some(
      (s) =>
        !identities.some(
          (r) =>
            r.secretRef === s.secretRef && r.secretVersionId === s.versionId,
        ),
    )
  )
    throw new Error("UNASSIGNED_SECRET_VERSION");
  for (const adapter of adapters) {
    if (!expectedAdapters.has(adapter.versionId))
      throw new Error("UNRELATED_AUTH_ADAPTER");
    if (adapter.workspaceId !== snapshot.workspaceId)
      throw new Error("AUTH_ADAPTER_WORKSPACE_MISMATCH");
    if (sha256(canonicalBytes(adapter.configuration)) !== adapter.contentHash)
      throw new Error("AUTH_ADAPTER_HASH_MISMATCH");
  }
  const environmentAsset = source.assets.find(
    (a) => a.versionId === snapshot.environmentVersionId,
  );
  if (environmentAsset) {
    if (
      environmentAsset.kind !== "ENVIRONMENT" ||
      sha256(canonicalBytes(environmentAsset.document)) !==
        sha256(canonicalBytes(snapshot.environment))
    )
      throw new Error("ENVIRONMENT_VERSION_MISMATCH");
    for (const adapter of adapters)
      if (
        !source.authAdapters?.some(
          (a) => sha256(canonicalBytes(a)) === sha256(canonicalBytes(adapter)),
        )
      )
        throw new Error("AUTH_ADAPTER_SOURCE_MISMATCH");
  }
  const cloneFiles = Object.fromEntries(
    Object.entries(files).map(([path, data]) => [path, data.slice()]),
  );
  return {
    bundle: structuredClone(bundle),
    files: cloneFiles,
    entrypoint: selected.path,
    snapshot: structuredClone(snapshot),
  };
}
