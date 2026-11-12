/**
 * 本文件在签名与哈希校验通过后做跨成员来源检查：安装前核对快照、清单与资产引用一致性（content/BUNDLE_DEPENDENCY_MISSING）。
 */

/** Cross-member provenance checks after signature/hash verification, before install. */
import { createHash } from "node:crypto";
import { analyze, verifyFiles, verifyDistribution } from "@veriq/compiler";
import {
    canonicalBytes,
    assetSourceBytes,
    validateSchema,
    type AssetSnapshotV1,
    type BundleManifestV1,
    type CompiledAssetBundle,
    type BundleResourcesV1,
    type ApprovedEngineInventoryV1,
} from "@veriq/contracts";
const hash = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const equal = (a: unknown, b: unknown) =>
    Buffer.from(canonicalBytes(a)).equals(Buffer.from(canonicalBytes(b)));
/**
 * 公开函数 validateContent 核对清单、快照与成员哈希的交叉引用：发现漂移立即拒绝安装：防止签名通过但内容不一致的包落地。
 */
export function validateContent(
    contents: Map<string, Buffer>,
    manifest: BundleManifestV1,
    snapshot: AssetSnapshotV1,
): { resources: BundleResourcesV1; dslOnly: boolean } {
    function read<T>(path: string, schema?: string): T {
        const raw = contents.get(path);
        if (!raw) throw new Error("BUNDLE_DEPENDENCY_MISSING");
        const value: unknown = JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(raw),
        );
        if (schema && validateSchema(schema, value).length)
            throw new Error("INVALID_BUNDLE_SCHEMA");
        return value as T;
    }
    const selection = read<{
        caseVersionIds?: string[];
        suiteVersionId?: string;
        draftValidationJobId?: string;
        environmentVersionId: string;
        validationStatus: string;
    }>("selection.json", "BundleSelectionV1");
    const dslOnly = !!selection.draftValidationJobId;
    if (
        selection.validationStatus !== manifest.validationStatus ||
        (dslOnly && manifest.validationStatus !== "UNVALIDATED_DEBUG")
    )
        throw new Error("INVALID_BUNDLE_MODE");
    const resources = read<BundleResourcesV1>(
        "resources.json",
        "BundleResourcesV1",
    );
    if (
        snapshot.assets.length > 1000 ||
        contents.get("snapshot.json")!.length > 16 * 1024 * 1024
    )
        throw new Error("BUNDLE_SIZE_LIMIT");
    const assets = new Map(snapshot.assets.map((a) => [a.versionId, a]));
    if (
        assets.size !== snapshot.assets.length ||
        resources.resources.some((r) => r.workspaceId !== manifest.workspaceId) ||
        resources.versions.some((v) => v.workspaceId !== manifest.workspaceId) ||
        new Set(resources.versions.map((v) => v.id)).size !==
            resources.versions.length ||
        new Set(resources.resources.map((r) => r.id)).size !==
            resources.resources.length
    )
        throw new Error("BUNDLE_SNAPSHOT_MISMATCH");
    const environment = assets.get(selection.environmentVersionId);
    if (environment?.kind !== "ENVIRONMENT")
        throw new Error("BUNDLE_ENVIRONMENT_MISSING");
    // Shared compiler analysis owns schema references and public auth bindings.
    // Combined exports add the independently selected ENVIRONMENT to execution roots.
    // Draft DSL may have business/type diagnostics; only binding diagnostics block it.
    const bindings = new Set([
        "INVALID_ENTRY_CASE",
        "DUPLICATE_ENTRY_CASE",
        "INVALID_VALIDATION_TARGET",
        "DUPLICATE_VERSION",
        "UNRELATED_AUTH_ADAPTER",
        "AUTH_ADAPTER_WORKSPACE_MISMATCH",
        "AUTH_ADAPTER_HASH_MISMATCH",
        "AUTH_ADAPTER_REQUIRED",
    ]);
    const issues = analyze(snapshot).issues.filter(
        (issue) => bindings.has(issue.code) || issue.path === "/authAdapters",
    );
    if (issues.length) throw new Error("BUNDLE_BINDING_MISMATCH");
    let engine: ApprovedEngineInventoryV1["engines"][number] | undefined;
    let draft: AssetSnapshotV1 | undefined;
    if (dslOnly) {
        const metadata = read<{ frozenAt: string }>("draft/metadata.json");
        if (validateSchema("Timestamp", metadata.frozenAt).length)
            throw new Error("BUNDLE_PROVENANCE_MISMATCH");
        draft = read<AssetSnapshotV1>("draft/source.json", "AssetSnapshotV1");
        if (
            !draft.validationTarget ||
            !equal(draft.validationTarget, snapshot.validationTarget) ||
            hash(assetSourceBytes(draft as unknown as Record<string, unknown>)) !==
                draft.sourceHash ||
            draft.workspaceId !== manifest.workspaceId ||
            draft.engineVersion !== manifest.engineVersion
        )
            throw new Error("BUNDLE_PROVENANCE_MISMATCH");
        if ([...contents.keys()].some((p) => p.startsWith("compiled/")))
            throw new Error("INVALID_BUNDLE_MODE");
        const requirements = read<{
            engineVersion: string;
            localCompilationRequired: boolean;
        }>("engine/requirements.json");
        if (
            requirements.engineVersion !== manifest.engineVersion ||
            requirements.localCompilationRequired !== true
        )
            throw new Error("BUNDLE_ENGINE_MISMATCH");
    } else {
        const engines = read<ApprovedEngineInventoryV1>(
            "engine/inventory.json",
            "ApprovedEngineInventoryV1",
        ).engines;
        engine = engines[0];
        if (
            engines.length !== 1 ||
            engine!.engineVersion !== manifest.engineVersion
        )
            throw new Error("BUNDLE_ENGINE_MISMATCH");
        for (const path of [
            "package.json",
            "package-lock.json",
            "dependencies.json",
        ]) {
            const entry = engine!.files.find((f) => f.path === path),
                raw = contents.get("engine/" + path);
            if (
                !entry ||
                !raw ||
                raw.length !== entry.sizeBytes ||
                hash(raw) !== entry.sha256
            )
                throw new Error("BUNDLE_ENGINE_MISMATCH");
        }
    }
    const rootIds = dslOnly
        ? [draft!.validationTarget!.versionId]
        : selection.suiteVersionId
            ? [selection.suiteVersionId]
            : selection.caseVersionIds!;
    if (
        !rootIds?.length ||
        rootIds.some(
            (id) =>
                assets.get(id)?.kind !==
                (selection.suiteVersionId
                    ? "SUITE"
                    : dslOnly
                        ? assets.get(id)?.kind
                        : "CASE"),
        )
    )
        throw new Error("BUNDLE_SELECTION_MISMATCH");
    const selectedRoot = assets.get(rootIds[0]!);
    const expectedEntries = dslOnly
        ? draft!.entryCaseVersionIds
        : selection.suiteVersionId && selectedRoot?.kind === "SUITE"
            ? [...new Set(selectedRoot.document.cases.map((row) => row.versionId))]
            : selection.caseVersionIds!;
    if (
        !equal(
            [...snapshot.entryCaseVersionIds].sort(),
            [...expectedEntries].sort(),
        )
    )
        throw new Error("BUNDLE_SELECTION_MISMATCH");
    const visited = new Set<string>(),
        visiting = new Set<string>();
    function visit(id: string, kind?: string) {
        const asset = assets.get(id);
        if (!asset || (kind && asset.kind !== kind))
            throw new Error("BUNDLE_DEPENDENCY_MISSING");
        if (visiting.has(id) || visiting.size >= 100)
            throw new Error("BUNDLE_DEPENDENCY_CYCLE");
        if (visited.has(id)) return;
        visiting.add(id);
        const doc = asset.document as unknown as Record<string, unknown>;
        if (asset.kind === "CASE")
            for (const [field, target] of [
                ["catalogVersionId", "ELEMENT_CATALOG"],
                ["datasetVersionId", "DATASET"],
                ["fixtureVersionId", "FIXTURE"],
            ])
                if (doc[field!]) visit(doc[field!] as string, target);
        if (asset.kind === "SUITE")
            for (const row of doc.cases as {
                versionId: string;
                datasetVersionId?: string;
            }[]) {
                visit(row.versionId, "CASE");
                if (row.datasetVersionId) visit(row.datasetVersionId, "DATASET");
            }
        const assertions: Record<string, unknown>[] = [
            ...(asset.kind === "ASSERTION_TEMPLATE"
                ? (doc.assertions as Record<string, unknown>[])
                : []),
        ];
        if (asset.kind === "CASE" || asset.kind === "FLOW")
            for (const step of doc.steps as Record<string, unknown>[]) {
                if (step.action === "callFlow") visit(step.versionId as string, "FLOW");
                assertions.push(
                    ...((step.beforeAssertions as Record<string, unknown>[]) ?? []),
                    ...((step.afterAssertions as Record<string, unknown>[]) ?? []),
                );
            }
        for (const a of assertions)
            if (a.type === "template")
                visit(a.versionId as string, "ASSERTION_TEMPLATE");
        visiting.delete(id);
        visited.add(id);
    }
    for (const id of [...rootIds, selection.environmentVersionId]) visit(id);
    if (visited.size !== assets.size) throw new Error("BUNDLE_EXTRA_DEPENDENCY");
    for (const asset of snapshot.assets) {
        if (
            hash(canonicalBytes({ kind: asset.kind, document: asset.document })) !==
                asset.sha256 ||
            !equal(read(`assets/${asset.versionId}.json`), asset)
        )
            throw new Error("BUNDLE_ASSET_MISMATCH");
        if (
            !resources.resources.some(
                (r) => r.id === asset.resourceId && r.kind === asset.kind,
            )
        )
            throw new Error("BUNDLE_RESOURCES_MISSING");
        if (dslOnly && asset.versionId === draft!.validationTarget!.versionId)
            continue;
        const version = resources.versions.find((v) => v.id === asset.versionId);
        if (
            !version ||
            version.resourceId !== asset.resourceId ||
            version.sha256 !== asset.sha256 ||
            !equal(version.content, { kind: asset.kind, document: asset.document })
        )
            throw new Error("BUNDLE_ASSET_MISMATCH");
        const prefix = `provenance/${asset.versionId}`;
        const source = read<AssetSnapshotV1>(
            prefix + "/source.json",
            "AssetSnapshotV1",
        );
        const descriptor = read<CompiledAssetBundle>(
            prefix + "/descriptor.json",
            "CompiledAssetBundle",
        );
        const receipt = read<{
            sourceHash: string;
            compiledBundleSha256: string;
            engineVersion: string;
            compilerTrust: string;
            revision: number;
        }>(prefix + "/receipt.json");
        if (
            source.workspaceId !== manifest.workspaceId ||
            source.engineVersion !== manifest.engineVersion ||
            hash(assetSourceBytes(source as unknown as Record<string, unknown>)) !==
                source.sourceHash ||
            !equal(
                source.assets.find((a) => a.versionId === asset.versionId),
                asset,
            ) ||
            source.validationTarget?.versionId !== asset.versionId ||
            source.validationTarget?.resourceId !== asset.resourceId ||
            receipt.revision !== source.validationTarget?.revision ||
            receipt.compilerTrust !== "MANAGED" ||
            receipt.sourceHash !== source.sourceHash ||
            receipt.engineVersion !== manifest.engineVersion ||
            descriptor.sourceHash !== source.sourceHash ||
            descriptor.engineVersion !== manifest.engineVersion ||
            hash(contents.get(prefix + "/descriptor.json")!) !==
                receipt.compiledBundleSha256
        )
            throw new Error("BUNDLE_PROVENANCE_MISMATCH");
        const entries = descriptor.entrypoints.map((e) => e.caseVersionId);
        if (
            new Set(entries).size !== entries.length ||
            !equal([...entries].sort(), [...source.entryCaseVersionIds].sort()) ||
            !!descriptor.validationOnly !== (entries.length === 0) ||
            descriptor.entrypoints.some(
                (e) => !descriptor.files.some((f) => f.path === e.path),
            ) ||
            analyze(source).issues.length ||
            source.assets.some((a) => !equal(a, assets.get(a.versionId))) ||
            (source.authAdapters ?? []).some(
                (a) =>
                    !equal(
                        a,
                        snapshot.authAdapters?.find(
                            (current) => current.versionId === a.versionId,
                        ),
                    ),
            )
        )
            throw new Error("BUNDLE_PROVENANCE_MISMATCH");
        if (
            engine &&
            (descriptor.compilerVersion !== engine.compilerVersion ||
                descriptor.runnerSdkVersion !== engine.runnerSdkVersion ||
                !equal(descriptor.dependencies, engine.dependencies))
        )
            throw new Error("BUNDLE_ENGINE_MISMATCH");
        if (!dslOnly) {
            const prefix = `compiled/${asset.versionId}/`;
            const files = Object.fromEntries(
                [...contents]
                    .filter(([p]) => p.startsWith(prefix))
                    .map(([p, raw]) => [p.slice(prefix.length), raw]),
            );
            try {
                verifyFiles(descriptor, files);
            } catch {
                throw new Error("BUNDLE_COMPILED_MISMATCH");
            }
            for (const path of [
                "package.json",
                "package-lock.json",
                "dependencies.json",
            ])
                if (
                    !files[path] ||
                    !files[path]!.equals(contents.get("engine/" + path)!)
                )
                    throw new Error("BUNDLE_ENGINE_MISMATCH");
            if (!equal(read("engine/dependencies.json"), descriptor.dependencies))
                throw new Error("BUNDLE_ENGINE_MISMATCH");
            try {
                verifyDistribution(
                    {
                        engineVersion: descriptor.engineVersion,
                        runnerSdkVersion: descriptor.runnerSdkVersion,
                        dependencies: descriptor.dependencies,
                        packageJson: files["package.json"]!,
                        packageLock: files["package-lock.json"]!,
                        files: Object.fromEntries(
                            Object.entries(files).filter(([path]) =>
                                path.startsWith("vendor/"),
                            ),
                        ),
                    },
                    manifest.engineVersion,
                );
            } catch {
                throw new Error("BUNDLE_ENGINE_MISMATCH");
            }
        }
        if (!dslOnly)
            for (const file of descriptor.files) {
                const raw = contents.get(`compiled/${asset.versionId}/${file.path}`);
                if (!raw || raw.length !== file.sizeBytes || hash(raw) !== file.sha256)
                    throw new Error("BUNDLE_DEPENDENCY_MISSING");
            }
    }
    const expectedVersionCount = assets.size - (dslOnly ? 1 : 0);
    if (resources.versions.length !== expectedVersionCount)
        throw new Error("BUNDLE_EXTRA_DEPENDENCY");
    if (draft && draft.assets.some((a) => !equal(a, assets.get(a.versionId))))
        throw new Error("BUNDLE_PROVENANCE_MISMATCH");
    return { resources, dslOnly };
}
