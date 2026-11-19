import { canonicalBytes, validateSchema, type ResourceDocumentV1 } from "@veriq/contracts";
import { request } from "../../api";
import {
    sampleOrder,
    type CredentialBinding,
    type ImportEvent,
    type ImportOptions,
    type ImportProgress,
    type ImportSecrets,
    type SamplePackage,
    type Schemas,
} from "./types";

/**
 * 固定导入错误码只表达需要用户采取的动作，错误正文不拼接HTTP响应、凭据、URL查询或业务输入，避免一次导入失败把秘密扩散
 * 到页面通知、日志或可访问标签。
 */
export class SampleImportError extends Error {}

const stable = (value: unknown) => new TextDecoder().decode(canonicalBytes(value));
const same = (left: unknown, right: unknown) => stable(left) === stable(right);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 目标origin必须明确可达且不携带认证信息、路径或片段，非loopback使用HTTPS；允许origin仅取自这三份已检查地址，不把任何
 * 清单字符串当成可扩大网络权限的通配符。
 */
export function targetOrigin(value: string): string {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new SampleImportError("TARGET_ORIGIN_INVALID");
    }
    if (
        !["https:", "http:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.pathname !== "/" ||
        url.search ||
        url.hash ||
        (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    ) {
        throw new SampleImportError("TARGET_ORIGIN_INVALID");
    }
    return url.origin;
}

/**
 * 只有固定清单顺序、真实DSL Schema和合法UUID别名都成立才接受包数据，防止损坏安装把任意路径或错误资产类型交给向导；真正
 * 跨引用语义仍由后续受管理编译器验证。
 */
export async function loadSamplePackage(signal: AbortSignal): Promise<SamplePackage> {
    const value = await request<Schemas["SampleWorkspacePackageDTO"]>(
        "/examples/sample-workspace",
        "GET",
        undefined,
        signal,
    );
    const candidate = value as unknown as SamplePackage;
    if (
        candidate.schemaVersion !== "1.0" ||
        candidate.manifest?.schemaVersion !== "1.0" ||
        !same(candidate.manifest.order, sampleOrder) ||
        !candidate.manifest.versionAliases ||
        !candidate.assets ||
        !candidate.sourceInventory
    )
        throw new SampleImportError("SAMPLE_PACKAGE_INVALID");
    for (const key of [...sampleOrder, "adapter", "business", "fixture-secret"]) {
        if (!uuid.test(candidate.manifest.versionAliases[key] ?? ""))
            throw new SampleImportError("SAMPLE_PACKAGE_INVALID");
    }
    for (const key of sampleOrder) {
        if (validateSchema("ResourceDocumentV1", candidate.assets[key]).length)
            throw new SampleImportError("SAMPLE_PACKAGE_INVALID");
    }
    const kinds = ["ELEMENT_CATALOG", "DATASET", "FIXTURE", "FLOW", "CASE", "SUITE", "ENVIRONMENT"];
    if (sampleOrder.some((key, index) => candidate.assets[key].kind !== kinds[index]))
        throw new SampleImportError("SAMPLE_PACKAGE_INVALID");
    return candidate;
}

/**
 * 所有分页都使用当前员工传输和同一取消信号，游标作为不透明字符串原样编码，避免只读第一页导致错误创建重复资源或把相邻空
 * 间的列表结果拼进当前导入状态。
 */
export async function allItems<T>(path: string, signal: AbortSignal): Promise<T[]> {
    const result: T[] = [];
    let cursor: string | null = null;
    do {
        const page: { items: T[]; nextCursor: string | null } = await request(
            path + (cursor ? `${path.includes("?") ? "&" : "?"}cursor=${encodeURIComponent(cursor)}` : ""),
            "GET",
            undefined,
            signal,
        );
        result.push(...page.items);
        cursor = page.nextCursor;
    } while (cursor);
    return result;
}

function rewrite(value: unknown, aliases: Record<string, string>): unknown {
    if (Array.isArray(value)) return value.map((item) => rewrite(item, aliases));
    if (value && typeof value === "object")
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewrite(item, aliases)]));
    return typeof value === "string" ? (aliases[value] ?? value) : value;
}

async function pause(signal: AbortSignal, ms: number): Promise<void> {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
        const abort = () => {
            clearTimeout(timer);
            reject(new DOMException("Aborted", "AbortError"));
        };
        const timer = setTimeout(() => {
            signal.removeEventListener("abort", abort);
            resolve();
        }, ms);
        signal.addEventListener("abort", abort, { once: true });
    });
}

/**
 * 恢复指纹只绑定非秘密目标选择和实际包来源，不写入明文凭据；用户修改地址、角色、设备或模板后必须启动独立导入，不能把原
 * 回执偷偷应用于新环境内容。
 */
export function importFingerprint(options: ImportOptions, sample: SamplePackage): string {
    return stable({ options, sourceInventory: sample.sourceInventory });
}

/**
 * 导入器以真实资源头和草稿为权威事实，已发布内容必须逐字段相同才复用；验证始终使用当前preview的revision/sourceHash，读
 * 取PASSED作业的匹配回执后才发布，取消只停止本地请求而不伪造远端取消。
 */
export async function importSample(
    sample: SamplePackage,
    options: ImportOptions,
    secrets: ImportSecrets,
    progress: ImportProgress,
    signal: AbortSignal,
    save: (value: ImportProgress) => void,
    notify: (event: ImportEvent) => void,
): Promise<{ workspaceId: string; planId: string }> {
    if (!uuid.test(options.workspaceId) || !uuid.test(options.runtimeId))
        throw new SampleImportError("SELECTION_INVALID");
    const fingerprint = importFingerprint(options, sample);
    if (progress.workspaceId !== options.workspaceId || progress.fingerprint !== fingerprint)
        throw new SampleImportError("IMPORT_OPTIONS_CHANGED");
    const base = `/workspaces/${options.workspaceId}`;
    await request(base, "GET", undefined, signal);
    const persist = () => {
        signal.throwIfAborted();
        save(structuredClone(progress));
    };
    notify({ phase: "identity" });
    if (progress.adapterVersion && secrets.adapterVersion && progress.adapterVersion !== secrets.adapterVersion)
        throw new SampleImportError("IMPORT_OPTIONS_CHANGED");
    if (!progress.adapterVersion) {
        if (secrets.adapterVersion) {
            const adapter = (await allItems<Schemas["AuthAdapterDTO"]>(base + "/auth-adapters", signal)).find(
                (item) => item.versionId === secrets.adapterVersion && !item.revoked,
            );
            if (!adapter || adapter.configuration.kind !== "HTTP_BEARER")
                throw new SampleImportError("ADAPTER_INVALID");
            progress.adapterVersion = adapter.versionId;
        } else {
            const adapter = await request<Schemas["AuthAdapterDTO"]>(
                base + "/auth-adapters",
                "POST",
                {
                    configuration: {
                        kind: "HTTP_BEARER",
                        identityPath: "/me",
                        identityPointer: "/id",
                    },
                },
                signal,
            );
            progress.adapterVersion = adapter.versionId;
        }
        persist();
    }
    const currentAdapter = (await allItems<Schemas["AuthAdapterDTO"]>(base + "/auth-adapters", signal)).find(
        (item) =>
            item.versionId === progress.adapterVersion && !item.revoked && item.configuration.kind === "HTTP_BEARER",
    );
    if (!currentAdapter) throw new SampleImportError("ADAPTER_INVALID");
    const credentials = await allItems<Schemas["CredentialDTO"]>(base + "/credentials", signal);
    for (const kind of ["business", "fixture"] as const) {
        const version = kind === "business" ? secrets.businessVersion : secrets.fixtureVersion;
        const secretRef = kind === "business" ? options.businessRef : options.fixtureRef;
        const identity = kind === "business" ? options.businessIdentity : options.fixtureIdentity;
        const token = kind === "business" ? secrets.businessToken : secrets.fixtureToken;
        const previous = progress[kind];
        if (previous && version && previous.versionId !== version)
            throw new SampleImportError("IMPORT_OPTIONS_CHANGED");
        if (previous) {
            if (
                previous.secretRef !== secretRef ||
                !credentials.some(
                    (item) =>
                        item.versionId === previous.versionId &&
                        item.secretRef === secretRef &&
                        !item.revoked &&
                        item.allowedIdentityIds.includes(identity),
                )
            )
                throw new SampleImportError("CREDENTIAL_SELECTION_INVALID");
            continue;
        }
        let binding: CredentialBinding;
        if (version) {
            const selected = credentials.find(
                (item) =>
                    item.versionId === version &&
                    item.secretRef === secretRef &&
                    !item.revoked &&
                    item.allowedIdentityIds.includes(identity),
            );
            if (!selected) throw new SampleImportError("CREDENTIAL_SELECTION_INVALID");
            binding = { secretRef, versionId: selected.versionId };
        } else {
            if (token.length < 24 || /[\r\n]/.test(token)) throw new SampleImportError("CREDENTIAL_INPUT_INVALID");
            const created = await request<Schemas["CredentialDTO"]>(
                base + "/credentials",
                "POST",
                {
                    secretRef,
                    value: { token },
                    allowedIdentityIds: [identity],
                },
                signal,
            );
            binding = { secretRef, versionId: created.versionId };
        }
        progress[kind] = binding;
        persist();
    }
    const aliases: Record<string, string> = {};
    const sourceAliases = sample.manifest.versionAliases;
    aliases[sourceAliases.adapter!] = progress.adapterVersion!;
    aliases[sourceAliases.business!] = progress.business!.versionId;
    aliases[sourceAliases["fixture-secret"]!] = progress.fixture!.versionId;
    const resources = await allItems<Schemas["ResourceDTO"]>(base + "/resources", signal);
    for (const asset of sampleOrder) {
        signal.throwIfAborted();
        const content = rewrite(sample.assets[asset], aliases) as ResourceDocumentV1;
        if (content.kind === "CASE") content.document.roleKey = options.roleKey;
        if (content.kind === "SUITE") for (const item of content.document.cases) item.roleKeys = [options.roleKey];
        if (content.kind === "ENVIRONMENT") {
            Object.assign(content.document, {
                baseURL: options.baseURL,
                apiBaseURL: options.apiBaseURL,
                fixtureBaseURL: options.fixtureBaseURL,
                allowedOrigins: [...new Set([options.baseURL, options.apiBaseURL, options.fixtureBaseURL])],
                buildSha: options.buildSha,
                locale: options.locale,
                timezone: options.timezone,
                roles: [
                    {
                        roleKey: options.roleKey,
                        authAdapterVersionId: progress.adapterVersion,
                        secretRef: progress.business!.secretRef,
                        secretVersionId: progress.business!.versionId,
                        allowedIdentityIds: [options.businessIdentity],
                    },
                ],
                fixtureIdentity: {
                    authAdapterVersionId: progress.adapterVersion,
                    secretRef: progress.fixture!.secretRef,
                    secretVersionId: progress.fixture!.versionId,
                    allowedIdentityIds: [options.fixtureIdentity],
                },
            });
        }
        if (validateSchema("ResourceDocumentV1", content).length) throw new SampleImportError("SAMPLE_PACKAGE_INVALID");
        const key = "demo-" + asset;
        let resource = resources.find((item) => item.kind === content.kind && item.key === key);
        if (!resource)
            resource = await request<Schemas["ResourceDTO"]>(
                base + "/resources",
                "POST",
                { kind: content.kind, key, name: "Demo " + asset, content },
                signal,
            );
        if (resource.status === "ARCHIVED") throw new SampleImportError("RESOURCE_CHANGED");
        const route = `${base}/resources/${resource.id}`;
        let published: string;
        if (resource.latestVersionId) {
            const version = await request<Schemas["ResourceVersionDTO"]>(
                `${route}/versions/${resource.latestVersionId}`,
                "GET",
                undefined,
                signal,
            );
            if (!same(version.content, content)) throw new SampleImportError("RESOURCE_CHANGED");
            published = version.id;
        } else {
            const draft = await request<Schemas["DraftDTO"]>(route + "/draft", "GET", undefined, signal);
            if (!same(draft.content, content)) throw new SampleImportError("RESOURCE_CHANGED");
            const preview = await request<Schemas["ValidationPreviewDTO"]>(
                route + "/validation-preview",
                "GET",
                undefined,
                signal,
            );
            let job = await request<Schemas["JobDTO"]>(
                route + "/validate",
                "POST",
                { revision: preview.revision, sourceHash: preview.sourceHash },
                signal,
            );
            const deadline = performance.now() + options.validationTimeout * 1000;
            while (true) {
                notify({
                    phase: "validating",
                    asset,
                    jobId: job.id,
                    state: job.state,
                    waitReason: job.waitReason,
                });
                if (job.state === "FINISHED") break;
                if (performance.now() >= deadline) throw new SampleImportError("VALIDATION_TIMEOUT");
                await pause(signal, Math.min(2000, Math.max(0, deadline - performance.now())));
                job = await request<Schemas["JobDTO"]>(`${base}/jobs/${job.id}`, "GET", undefined, signal);
            }
            if (job.outcome !== "PASSED") throw new SampleImportError("VALIDATION_FAILED");
            const receipt = await request<Schemas["ValidationReceiptDTO"]>(
                `${base}/jobs/${job.id}/validation-receipt`,
                "GET",
                undefined,
                signal,
            );
            if (
                receipt.resourceId !== resource.id ||
                receipt.revision !== preview.revision ||
                receipt.sourceHash !== preview.sourceHash
            )
                throw new SampleImportError("RECEIPT_CHANGED");
            const version = await request<Schemas["ResourceVersionDTO"]>(
                route + "/publish",
                "POST",
                { revision: preview.revision, validationReceiptId: receipt.id },
                signal,
            );
            published = version.id;
        }
        aliases[sourceAliases[asset]!] = published;
        progress.versions[asset] = published;
        persist();
        notify({ phase: "published", asset });
    }
    notify({ phase: "plan" });
    const selection: Schemas["ExecutionPlanWrite"] = {
        name: "Demo employee smoke",
        suiteVersionId: progress.versions.suite!,
        environmentVersionId: progress.versions.environment!,
        runtimeIds: [options.runtimeId],
        browsers: ["chromium"],
        roleKeys: [options.roleKey],
        variables: {},
        overlapPolicy: "QUEUE",
        maxCaseRetries: 0,
    };
    const matches = (plan: Schemas["ExecutionPlanDTO"]) =>
        !plan.archived &&
        Object.entries(selection).every(([key, value]) => same(plan[key as keyof typeof plan], value));
    let plan: Schemas["ExecutionPlanDTO"];
    if (progress.planId) {
        plan = await request(`${base}/execution-plans/${progress.planId}`, "GET", undefined, signal);
        if (!matches(plan)) throw new SampleImportError("PLAN_CHANGED");
    } else {
        const existing = (await allItems<Schemas["ExecutionPlanDTO"]>(base + "/execution-plans", signal)).find(matches);
        plan = existing ?? (await request(base + "/execution-plans", "POST", selection, signal));
        progress.planId = plan.id;
        persist();
    }
    return { workspaceId: options.workspaceId, planId: plan.id };
}
