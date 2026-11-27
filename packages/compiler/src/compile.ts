/**
 * 本文件把通过校验的 DSL 快照编译为不可变 TypeScript 产物：并组装可验证的执行发行闭包：生成代码不得嵌入执行上下文。
 */

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
    type ConnectedSourceSnapshotV2,
    type CompiledAssetBundle,
    type DependencyVersion,
    type ExecutionSnapshotV1,
    type FileEntry,
    type CompiledStep,
    type CaseStepPhase,
} from "@veriq/contracts";
import { analyze, validate, type CompiledCase } from "./validate.js";
import { sha256 } from "./dependency.js";
/**
 * 公开常量 COMPILER_VERSION 标识编译器语义版本：写入产物元数据：供运行时核对引擎匹配（COMPILER_VERSION）。
 */
export const COMPILER_VERSION = "0.1.0";
/**
 * 公开常量 SOURCE_SNAPSHOT_PATH 固定源快照在发行包内的相对路径：安装与核对均依赖该约定（SOURCE_SNAPSHOT_PATH）。
 */
export const SOURCE_SNAPSHOT_PATH = "source/asset-snapshot.json";
/**
 * 公开接口 EngineDistribution 描述编译所用引擎发行闭包：含 package/lock/依赖与 vendor 文件字节。
 */
export interface EngineDistribution {
    engineVersion: string;
    runnerSdkVersion: string;
    /**
     * 从引擎发行读取可安装的包清单和 npm 三版锁文件，校验成功后将这两份输入的精确字节交给执行包。
     */
    packageJson: Uint8Array;
    packageLock: Uint8Array;
    /**
     * 依赖清单记录直接和传递包的精确版本及完整性值，装配时逐项和锁文件核对，缺项或多项均会失败。
     */
    dependencies: DependencyVersion[];
    /**
     * 这里只接收 vendor/ 下的离线 npm 归档，锁文件逐个引用它们，装配时重算归档完整性以核对库存。
     */
    files: Record<string, Uint8Array>;
}
/**
 * 公开接口 CompiledOutput 表示编译产物：含生成文件表与 CompiledAssetBundle 元数据（CompiledOutput/ENGINE_DISTRIBUTION_
 * REQUIRED）。
 */
export interface CompiledOutput {
    bundle: CompiledAssetBundle;
    files: Record<string, Uint8Array>;
}
/**
 * 公开接口 ExecutionPackage 描述可交给运行时装配的执行包：含编译产物与发行核对所需材料（ExecutionPackage/ENGINE_DISTRI
 * BUTION_REQUIRED）。
 */
export interface ExecutionPackage {
    bundle: CompiledAssetBundle;
    files: Record<string, Uint8Array>;
    entrypoint: string;
    snapshot: ExecutionSnapshotV1;
}
/**
 * T06 实现该导入 ABI；执行上下文由 worker 注入，编译器永不把上下文写进生成代码。公开接口 RunnerSdkV1
 * 描述生成代码依赖的 runner-sdk ABI：执行上下文由 worker 注入：编译器只发射惰性调用。
 */
export interface RunnerSdkV1 {
    registerCase(plan: CompiledCase, source: AssetSnapshotV1): void;
}
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
function parse(bytes: Uint8Array): Record<string, unknown> {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as Record<string, unknown>;
}
function checkSchema(name: string, value: unknown): void {
    const errors = validateSchema(name, value);
    if (errors.length) throw new Error(`INVALID_${name}: ${JSON.stringify(errors)}`);
}
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
function distributionFiles(d: EngineDistribution | undefined, engine: string): Record<string, Uint8Array> {
    if (!d) throw new Error("ENGINE_DISTRIBUTION_REQUIRED");
    if (d.engineVersion !== engine) throw new Error("ENGINE_VERSION_MISMATCH");
    const files: Record<string, Uint8Array> = Object.create(null) as Record<string, Uint8Array>;
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
    if (sha256(canonicalBytes(pkg.dependencies)) !== sha256(canonicalBytes(lock.packages[""].dependencies)))
        throw new Error("LOCK_ROOT_MISMATCH");
    const sdk = lock.packages["node_modules/@veriq/runner-sdk"];
    if (!Object.hasOwn(pkg.dependencies, "@veriq/runner-sdk") || !record(sdk) || sdk.version !== d.runnerSdkVersion)
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
            !/^node_modules\/(?:@[^/]+\/)?[^/]+(?:\/node_modules\/(?:@[^/]+\/)?[^/]+)*$/u.test(location) ||
            !record(node) ||
            node.link ||
            node.hasInstallScript
        )
            throw new Error("INVALID_LOCK_PACKAGE");
        const name = location.slice(location.lastIndexOf("node_modules/") + "node_modules/".length);
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
        if (dep.integrity !== "sha512-" + createHash("sha512").update(content).digest("base64"))
            throw new Error("DEPENDENCY_INTEGRITY_MISMATCH");
        for (const name of Object.keys(record(node.dependencies) ? node.dependencies : {})) {
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
    if (used.size !== inventory.size || usedFiles.size !== Object.keys(files).length)
        throw new Error("DEPENDENCY_CLOSURE_MISMATCH");
    for (const [name, resolved] of Object.entries(pkg.dependencies)) {
        const node = lock.packages["node_modules/" + name];
        if (!record(node) || node.resolved !== resolved) throw new Error("LOCK_ROOT_MISMATCH");
    }
    files["package.json"] = d.packageJson.slice();
    files["package-lock.json"] = d.packageLock.slice();
    files["dependencies.json"] = canonicalBytes(d.dependencies);
    return files;
}
/**
 * 核对与编译相同的引擎 package/lock/依赖闭包，但不执行其中任何代码。
 * 公开函数 verifyDistribution 核对引擎发行闭包与期望 engineVersion：不执行包内代码：哈希或版本不符即失败。
 */
export function verifyDistribution(distribution: EngineDistribution, engineVersion: string): void {
    distributionFiles(distribution, engineVersion);
}
function casePhases(plan: CompiledCase): { steps: CompiledStep[]; phase?: CaseStepPhase }[] {
    return [
        ...(plan.prepare ? [{ steps: plan.prepare, phase: "PREPARE" as const }] : []),
        { steps: plan.steps },
        ...(plan.cleanup ?? []).map(({ on, steps }) => ({ steps, phase: `CLEANUP_${on}` as const })),
    ];
}

/**
 * 使用 TypeScript printer 处理标识符与字符串转义；DSL 仅作为惰性 JSON 数据发射。
 */
function registration(plan: CompiledCase): Uint8Array {
    const f = ts.factory;
    const json = (v: unknown): ts.Expression =>
        f.createCallExpression(f.createPropertyAccessExpression(f.createIdentifier("JSON"), "parse"), undefined, [
            f.createStringLiteral(new TextDecoder().decode(canonicalBytes(v))),
        ]);
    const contextImport = f.createImportDeclaration(
        undefined,
        f.createImportClause(
            false,
            undefined,
            f.createNamedImports([f.createImportSpecifier(false, undefined, f.createIdentifier("source"))]),
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
                f.createNamedImports([f.createImportSpecifier(false, undefined, f.createIdentifier("registerCase"))]),
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
        ts.createSourceFile("case.test.ts", "", ts.ScriptTarget.ES2023, false, ts.ScriptKind.TS),
        statements,
    );
    return bytes(ts.createPrinter({ newLine: ts.NewLineKind.LineFeed }).printFile(file));
}
/**
 * 联网投影保持资产依赖顺序并锁定原始规范字节的摘要，两个静态数据版本只保留声明，行值由私有通道读取。
 */
export function projectConnectedSource(snapshot: AssetSnapshotV1): ConnectedSourceSnapshotV2 {
    return {
        ...snapshot,
        schemaVersion: "2.0",
        originalSha256: sha256(canonicalBytes(snapshot)),
        assets: snapshot.assets.map((asset) => {
            if (asset.kind !== "DATASET") return asset;
            const { document, ...identity } = asset;
            const schema =
                document.schemaVersion === "1.0"
                    ? { schemaVersion: document.schemaVersion, columns: document.columns }
                    : { schemaVersion: document.schemaVersion, shape: document.shape, fields: document.fields };
            return { ...identity, schema, contentSha256: sha256(canonicalBytes(document)) };
        }) as ConnectedSourceSnapshotV2["assets"],
    };
}
/**
 * 联网编译仍对整份原始冻结源执行语义校验，仅在生成可落盘文件时替换数据正文，离线旧契约继续按原格式读取。
 */
export function compileFiles(
    snapshot: AssetSnapshotV1,
    distribution?: EngineDistribution,
    options?: { connected: boolean },
): CompiledOutput {
    const analysis = analyze(snapshot);
    if (analysis.issues.length) throw new Error("ASSET_VALIDATION_FAILED: " + JSON.stringify(analysis.issues));
    const files = distributionFiles(distribution, snapshot.engineVersion);
    const { validationTarget: _target, ...source } = snapshot;
    // 联网编译将投影后的快照写入源文件，保留冻结来源与工作区标识，供下载产物恢复对应的源上下文。
    const retained = snapshot.entryCaseVersionIds.length ? (source as AssetSnapshotV1) : snapshot;
    const persisted = options?.connected ? projectConnectedSource(retained) : retained;
    files[SOURCE_SNAPSHOT_PATH] = canonicalBytes(persisted);
    if (snapshot.entryCaseVersionIds.length)
        files["source/context.ts"] = bytes(
            "export const source = JSON.parse(" +
                JSON.stringify(new TextDecoder().decode(canonicalBytes(persisted))) +
                ");\n",
        );
    const entrypoints = snapshot.entryCaseVersionIds.map((caseVersionId) => ({
        caseVersionId,
        path: `cases/${caseVersionId}.test.ts`,
    }));
    for (const entry of entrypoints)
        files[entry.path] = registration(analysis.cases.find((c) => c.caseVersionId === entry.caseVersionId)!);
    if (!entrypoints.length)
        files["validation.ts"] = bytes(
            "export const validationOnly = true;\nexport const assets = JSON.parse(" +
                JSON.stringify(new TextDecoder().decode(canonicalBytes(persisted.assets))) +
                ");\n",
        );
    const expectedCases = analysis.cases.map((plan) => {
        let ordinal = 0;
        const flatten = (steps: CompiledStep[], phase?: CaseStepPhase, parentId?: string): Record<string, unknown>[] =>
            steps.flatMap((step) => [
                {
                    id: step.step.id,
                    order: ordinal++,
                    ...(parentId ? { parentId } : {}),
                    ...(phase ? { phase } : {}),
                    failurePolicy: step.step.failurePolicy ?? "STOP",
                    assertions: [
                        ...step.before.map((a) => ({
                            id: a.assertion.id,
                            severity: a.assertion.severity,
                            ...("datasetExpected" in a.assertion ? { datasetExpected: true } : {}),
                            stage: a.assertion.type === "requestCount" ? "FINALIZE" : "BEFORE",
                        })),
                        ...step.responseAssertions.map((a) => ({
                            id: a.assertion.id,
                            severity: a.assertion.severity,
                            ...("datasetExpected" in a.assertion ? { datasetExpected: true } : {}),
                            stage: a.assertion.type === "requestCount" ? "FINALIZE" : "RESPONSE",
                        })),
                        ...step.after.map((a) => ({
                            id: a.assertion.id,
                            severity: a.assertion.severity,
                            ...("datasetExpected" in a.assertion ? { datasetExpected: true } : {}),
                            stage: a.assertion.type === "requestCount" ? "FINALIZE" : "AFTER",
                        })),
                    ],
                    observers: (step.step.observers ?? []).map((o) => o.id),
                },
                ...flatten(step.children ?? [], phase, step.step.id),
            ]);
        const writes = (steps: CompiledStep[]): boolean =>
            steps.some(
                ({ step, children }) =>
                    (step.action === "apiRequest" && !["GET", "HEAD", "OPTIONS"].includes(step.method)) ||
                    (step.observers ?? []).some(
                        (observer) =>
                            "method" in observer &&
                            typeof observer.method === "string" &&
                            !["GET", "HEAD", "OPTIONS"].includes(observer.method),
                    ) ||
                    writes(children ?? []),
            );
        return {
            caseVersionId: plan.caseVersionId,
            hasPotentialWrites: plan.document.kind === "WRITE" || casePhases(plan).some(({ steps }) => writes(steps)),
            requiredEvidenceKinds: ["TRACE"],
            steps: casePhases(plan).flatMap(({ steps, phase }) => flatten(steps, phase)),
            ...(plan.persistenceCheckpointStepId
                ? { persistenceCheckpointStepId: plan.persistenceCheckpointStepId }
                : {}),
        };
    });
    files["metadata/expected-plans.json"] = canonicalBytes({
        schemaVersion: "1.0",
        cases: expectedCases,
    });
    const displayCases = analysis.cases.map((plan) => {
        let order = 0;
        const flatten = (steps: CompiledStep[], phase?: CaseStepPhase, parentId?: string): Record<string, unknown>[] =>
            steps.flatMap((step) => [
                {
                    id: step.step.id,
                    sourceId: step.sourceId!,
                    sourcePath: step.sourcePath,
                    action: step.step.action,
                    order: order++,
                    ...(parentId ? { parentId } : {}),
                    ...(phase ? { phase } : {}),
                    assertions: [...step.before, ...step.responseAssertions, ...step.after].map((a) => ({
                        id: a.assertion.id,
                        sourceId: a.sourceId!,
                        sourcePath: a.sourcePath,
                        type: a.assertion.type,
                        ...("operator" in a.assertion ? { operator: a.assertion.operator } : {}),
                        expectedSource: a.assertion.expectedSource,
                        severity: a.assertion.severity,
                    })),
                    observers: (step.step.observers ?? []).map((o) => ({
                        id: o.id,
                        kind: "kind" in o ? o.kind : "HTTP",
                        ...("method" in o ? { method: o.method, path: o.path } : {}),
                    })),
                },
                ...flatten(step.children ?? [], phase, step.step.id),
            ]);
        return {
            caseVersionId: plan.caseVersionId,
            caseKey: plan.document.caseKey,
            title: plan.document.title,
            steps: casePhases(plan).flatMap(({ steps, phase }) => flatten(steps, phase)),
        };
    });
    files["metadata/report-display.json"] = canonicalBytes({
        schemaVersion: "1.0",
        cases: displayCases,
    });
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
        dependencies: structuredClone(distribution!.dependencies) as [DependencyVersion, ...DependencyVersion[]],
        ...(!entrypoints.length ? { validationOnly: true } : {}),
    };
    verifyFiles(bundle, files);
    return { bundle, files };
}
/**
 * 仅描述符兼容 API；上传/导出请用 compileFiles，且不维护隐藏文件缓存。
 * 公开函数 compileAssets 提供仅描述符的兼容编译入口：实际上委托 compileFiles：不隐藏进程级文件缓存。
 */
export function compileAssets(snapshot: AssetSnapshotV1, distribution?: EngineDistribution): CompiledAssetBundle {
    return compileFiles(snapshot, distribution).bundle;
}
/**
 * 公开函数 verifyFiles 在不执行的前提下核对编译产物文件哈希与清单一致性（verifyFiles/MISSING_VALIDATION_FILE）。
 */
export function verifyFiles(bundle: CompiledAssetBundle, files: Record<string, Uint8Array>): void {
    checkSchema("CompiledAssetBundle", bundle);
    if (bundle.validationOnly && !Object.hasOwn(files, "validation.ts")) throw new Error("MISSING_VALIDATION_FILE");
    const entries = new Set<string>();
    const paths = new Set<string>();
    for (const entry of bundle.entrypoints) {
        if (entries.has(entry.caseVersionId) || paths.has(entry.path)) throw new Error("DUPLICATE_ENTRYPOINT");
        entries.add(entry.caseVersionId);
        paths.add(entry.path);
        if (!Object.hasOwn(files, entry.path)) throw new Error("MISSING_ENTRYPOINT_FILE");
        if (entry.path !== `cases/${entry.caseVersionId}.test.ts`) throw new Error("ENTRYPOINT_MAPPING_MISMATCH");
    }
    const seen = new Set<string>();
    const folded = new Set<string>();
    for (const file of bundle.files) {
        const key = file.path.normalize("NFC").toLowerCase();
        if (seen.has(file.path) || folded.has(key)) throw new Error("DUPLICATE_FILE_PATH");
        seen.add(file.path);
        folded.add(key);
        if (file.path.split("/").some((x) => x === "" || x === ".") || !Object.hasOwn(files, file.path))
            throw new Error("MISSING_BUNDLE_FILE");
        const content = files[file.path]!;
        if (content.byteLength !== file.sizeBytes || sha256(content) !== file.sha256)
            throw new Error("FILE_HASH_MISMATCH");
    }
    if (Object.keys(files).length !== seen.size) throw new Error("UNMANIFESTED_FILE");
}
/**
 * 冷装配从下载的描述符与精确文件重建执行包，核对清单字节与工作空间后才能选出快照指定的用例。
 * 这里只使用下载内容，不依赖进程内身份注册表。
 */
export function assembleExecution(
    bundle: CompiledAssetBundle,
    snapshot: ExecutionSnapshotV1,
    files?: Record<string, Uint8Array>,
    original?: AssetSnapshotV1,
): ExecutionPackage {
    checkSchema("CompiledAssetBundle", bundle);
    checkSchema("ExecutionSnapshotV1", snapshot);
    if (bundle.validationOnly) throw new Error("VALIDATION_ONLY");
    if (!files) throw new Error("BUNDLE_FILES_REQUIRED");
    verifyFiles(bundle, files);
    const entries = new Set(bundle.entrypoints.map((entry) => entry.caseVersionId));
    const selected = bundle.entrypoints.find((e) => e.caseVersionId === snapshot.caseVersionId);
    if (!selected) throw new Error("UNKNOWN_SELECTED_CASE");
    const raw = files[SOURCE_SNAPSHOT_PATH];
    if (!raw) throw new Error("SOURCE_CONTEXT_REQUIRED");
    if (original && sha256(canonicalBytes(projectConnectedSource(original))) !== sha256(raw))
        throw new Error("COMPILED_PROVENANCE_MISMATCH");
    const source = original ?? (parse(raw) as AssetSnapshotV1);
    const problems = validate(source);
    if (problems.length) throw new Error("INVALID_SOURCE_CONTEXT: " + JSON.stringify(problems));
    if (source.workspaceId !== snapshot.workspaceId) throw new Error("WORKSPACE_MISMATCH");
    if (sha256(assetSourceBytes(source)) !== bundle.sourceHash || snapshot.assetSourceHash !== bundle.sourceHash)
        throw new Error("SOURCE_HASH_MISMATCH");
    if (source.engineVersion !== bundle.engineVersion) throw new Error("ENGINE_VERSION_MISMATCH");
    if (!files["package.json"] || !files["package-lock.json"]) throw new Error("MISSING_ENGINE_FILES");
    const vendorFiles = Object.fromEntries(Object.entries(files).filter(([path]) => path.startsWith("vendor/")));
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
        sha256(files["dependencies.json"]) !== sha256(canonicalBytes(bundle.dependencies))
    )
        throw new Error("DEPENDENCY_INVENTORY_MISMATCH");
    if (source.entryCaseVersionIds.length !== entries.size || source.entryCaseVersionIds.some((id) => !entries.has(id)))
        throw new Error("ENTRYPOINT_SOURCE_MISMATCH");
    const selectedCase = source.assets.find((a) => a.versionId === snapshot.caseVersionId);
    if (selectedCase?.kind !== "CASE") throw new Error("UNKNOWN_SELECTED_CASE");
    if (
        sha256(canonicalBytes(selectedCase.document.datasetBindings ?? {})) !==
        sha256(canonicalBytes(snapshot.datasetBindings ?? {}))
    )
        throw new Error("DATASET_BINDINGS_MISMATCH");
    const suite = source.assets.find((a) => a.kind === "SUITE");
    // 套件序号以冻结原数组为准，在筛选执行轴前先取条目；独立用例可保留历史多用例运行的原列表序号。
    const suiteEntries = suite?.document.cases;
    const entryIndex = snapshot.suiteEntryIndex;
    const candidates = entryIndex === undefined ? suiteEntries : suiteEntries?.slice(entryIndex, entryIndex + 1);
    const defaultDataset = selectedCase.document.datasetVersionId;
    const defaultRole = selectedCase.document.roleKey;
    const matrixVersions = candidates
        ?.filter(
            (entry) =>
                entry.versionId === snapshot.caseVersionId &&
                (entry.roleKeys ?? [defaultRole]).includes(snapshot.roleKey) &&
                (!entry.browsers || entry.browsers.includes(snapshot.browser)),
        )
        .map((entry) => entry.datasetVersionId ?? defaultDataset) ?? [defaultDataset];
    if (suite ? matrixVersions.length === 0 : defaultRole !== snapshot.roleKey) {
        throw new Error("ROLE_MISMATCH");
    }
    /**
     * 冻结版本存在时须先核对其归属，旧快照可以仅携带行；树父键和排序属于资产摘要而不进入执行行摘要。
     */
    const selectedRowHash = snapshot.dataRow ? sha256(canonicalBytes(snapshot.dataRow)) : undefined;
    const matchesData = matrixVersions.some((datasetId) => {
        if (snapshot.datasetVersionId !== undefined && datasetId !== snapshot.datasetVersionId) {
            return false;
        }
        if (!datasetId) return selectedRowHash === undefined;
        if (!selectedRowHash) return false;
        const dataset = source.assets.find((a) => a.versionId === datasetId);
        if (dataset?.kind !== "DATASET") return false;
        const d = dataset.document;
        const rows = d.schemaVersion === "1.0" ? d.rows : d.source.kind === "STATIC" ? d.source.rows : [];
        return rows.some(({ key, values }) => sha256(canonicalBytes({ key, values })) === selectedRowHash);
    });
    if (!matchesData) {
        throw new Error(matrixVersions.some(Boolean) ? "DATA_ROW_MISMATCH" : "UNEXPECTED_DATA_ROW");
    }
    const initialVariables = resolveInitialVariables(selectedCase.document.initialVariables, snapshot.variables);
    if (selectedCase.document.fixtureVersionId) {
        const fixture = source.assets.find((a) => a.versionId === selectedCase.document.fixtureVersionId);
        if (fixture?.kind !== "FIXTURE") throw new Error("FIXTURE_REQUIRED");
        const schemas = new Ajv2020({ strict: false, allErrors: true });
        addFormats.default(schemas);
        const input = resolveBinding(selectedCase.document.fixtureInput ?? {}, {
            data: snapshot.dataRow?.values ?? {},
            vars: initialVariables,
        });
        if (!schemas.compile(fixture.document.inputSchema)(input)) throw new Error("FIXTURE_INPUT_INVALID");
    }
    const origins = new Set(snapshot.environment.allowedOrigins);
    for (const base of [
        snapshot.environment.baseURL,
        snapshot.environment.apiBaseURL,
        snapshot.environment.fixtureBaseURL,
    ].filter((v): v is string => !!v))
        if (!origins.has(new URL(base).origin)) throw new Error("UNAUTHORIZED_ORIGIN");
    if (new Set(snapshot.environment.roles.map((r) => r.roleKey)).size !== snapshot.environment.roles.length)
        throw new Error("DUPLICATE_ROLE");
    if (new Set(snapshot.secretVersions.map((s) => s.secretRef)).size !== snapshot.secretVersions.length)
        throw new Error("DUPLICATE_SECRET_REFERENCE");
    const role = snapshot.environment.roles.find((r) => r.roleKey === snapshot.roleKey);
    if (!role) throw new Error("UNKNOWN_ROLE");
    if (!snapshot.secretVersions.some((s) => s.secretRef === role.secretRef && s.versionId === role.secretVersionId))
        throw new Error("SECRET_VERSION_MISMATCH");
    const identities = [
        role,
        ...(selectedCase.document.fixtureVersionId && snapshot.environment.fixtureIdentity
            ? [snapshot.environment.fixtureIdentity]
            : []),
    ];
    if (selectedCase.document.fixtureVersionId && !snapshot.environment.fixtureIdentity)
        throw new Error("FIXTURE_IDENTITY_REQUIRED");
    const expectedAdapters = new Set(identities.map((r) => r.authAdapterVersionId));
    const adapters = snapshot.authAdapters ?? [];
    if (new Set(adapters.map((a) => a.versionId)).size !== adapters.length) throw new Error("DUPLICATE_AUTH_ADAPTER");
    for (const identity of identities) {
        if (!adapters.some((a) => a.versionId === identity.authAdapterVersionId))
            throw new Error("AUTH_ADAPTER_REQUIRED");
        if (
            !snapshot.secretVersions.some(
                (s) => s.secretRef === identity.secretRef && s.versionId === identity.secretVersionId,
            )
        )
            throw new Error("SECRET_VERSION_MISMATCH");
    }
    if (
        snapshot.secretVersions.some(
            (s) => !identities.some((r) => r.secretRef === s.secretRef && r.secretVersionId === s.versionId),
        )
    )
        throw new Error("UNASSIGNED_SECRET_VERSION");
    for (const adapter of adapters) {
        if (!expectedAdapters.has(adapter.versionId)) throw new Error("UNRELATED_AUTH_ADAPTER");
        if (adapter.workspaceId !== snapshot.workspaceId) throw new Error("AUTH_ADAPTER_WORKSPACE_MISMATCH");
        if (sha256(canonicalBytes(adapter.configuration)) !== adapter.contentHash)
            throw new Error("AUTH_ADAPTER_HASH_MISMATCH");
    }
    const environmentAsset = source.assets.find((a) => a.versionId === snapshot.environmentVersionId);
    if (environmentAsset) {
        if (
            environmentAsset.kind !== "ENVIRONMENT" ||
            sha256(canonicalBytes(environmentAsset.document)) !== sha256(canonicalBytes(snapshot.environment))
        )
            throw new Error("ENVIRONMENT_VERSION_MISMATCH");
        for (const adapter of adapters)
            if (!source.authAdapters?.some((a) => sha256(canonicalBytes(a)) === sha256(canonicalBytes(adapter))))
                throw new Error("AUTH_ADAPTER_SOURCE_MISMATCH");
    }
    const cloneFiles = Object.fromEntries(Object.entries(files).map(([path, data]) => [path, data.slice()]));
    return {
        bundle: structuredClone(bundle),
        files: cloneFiles,
        entrypoint: selected.path,
        snapshot: structuredClone(snapshot),
    };
}
