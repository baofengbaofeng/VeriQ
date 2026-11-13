import { readFile, writeFile } from "node:fs/promises";

/** 桌面可调用的云端业务操作明确列举于此，生成器只读取现有 OpenAPI 以避免复制路由和正文类型；新增服务端接口不会自动成为渲染进程的新权限。 */
const allowed = new Set(
    `login session logout getSetup getAccount listWorkspaces getWorkspace
listResources createResource getResource updateResource getDraft updateDraft validateResource publishResource
listVersions getVersion listDependents previewResourceValidation getPublishedCompiledSource getJob getValidationReceipt
listRuns createRun getRun cancelRun rerun getRunReport streamRunReport getAttemptHistory getAttemptArtifacts
getReportDisplay downloadAttemptArtifact getWorkspaceAudit
listBundles createBundle getBundle getBundleManifest
listProviders createProvider getProvider updateProvider deleteProvider testProvider previewAiContext generateDraft
listGenerations getGeneration reviewGeneration cancelGeneration
listRuntimes getRuntime updateRuntimeGrants updateRuntimeTrust revokeRuntime updateRuntimeCredentialDelivery
inspectEnrollment approveEnrollment listCredentials createCredential rotateCredential revokeCredential
listAuthAdapters createAuthAdapter revokeAuthAdapter`.split(/\s+/),
);
const document = JSON.parse(
    await readFile(new URL("../../../packages/contracts/openapi/platform.yaml", import.meta.url)),
);
const catalog = {};
const types = [];
for (const [path, item] of Object.entries(document.paths)) {
    for (const [method, operation] of Object.entries(item)) {
        const name = operation.operationId;
        if (!allowed.has(name)) continue;
        const parameters = (operation.parameters ?? []).map((parameter) =>
            parameter.$ref
                ? document.components.parameters[parameter.$ref.split("/").at(-1)]
                : parameter,
        );
        const request = operation.requestBody?.content?.["application/json"]?.schema?.$ref
            ?.split("/")
            .at(-1);
        const ids = parameters
            .filter((parameter) => parameter.in === "path")
            .map((parameter) => parameter.name);
        const queries = Object.fromEntries(
            parameters
                .filter((parameter) => parameter.in === "query")
                .map((parameter) => [parameter.name, parameter.schema]),
        );
        const idempotency = parameters.some(
            (parameter) => parameter.in === "header" && parameter.name === "Idempotency-Key",
        );
        catalog[name] = {
            path,
            method: method.toUpperCase(),
            ids,
            queries,
            request: request ?? null,
            idempotency,
            kind:
                name === "streamRunReport"
                    ? "stream"
                    : name === "downloadAttemptArtifact"
                      ? "binary"
                      : name === "getPublishedCompiledSource"
                        ? "source"
                        : "json",
        };
        types.push(
            `    | { operation: ${JSON.stringify(name)}; ${ids.length ? `params: { ${ids.map((id) => `${id}: string`).join("; ")} };` : ""} ${Object.keys(queries).length ? "query?: Record<string, string | number | boolean>;" : ""} ${request ? `data: S[${JSON.stringify(request)}];` : ""} ${idempotency ? "idempotencyKey: string;" : ""} }`,
        );
        allowed.delete(name);
    }
}
if (allowed.size) throw new Error("Desktop operations missing from OpenAPI: " + [...allowed]);
await writeFile(
    new URL("../src/shared/operations.generated.json", import.meta.url),
    JSON.stringify(catalog, null, 4) + "\n",
);
await writeFile(
    new URL("../src/shared/operations.generated.ts", import.meta.url),
    `/** 由 generate-operations.mjs 根据明确的桌面白名单和 OpenAPI 自动生成，业务请求类型只允许固定操作与契约正文；请修改生成器并重新生成，禁止直接扩张宿主权限。 */\nimport type { PlatformComponents } from "@veriq/contracts";\ntype S = PlatformComponents["schemas"];\nexport type CloudOperation =\n${types.join("\n")};\n`,
);

/** OpenAPI 的登录等正文并不属于平台 DSL 定义集合，因此在生成阶段保留两套定义的命名空间并重写引用；宿主随后使用同一成熟 Ajv 实例检查完整正文，避免手写协议解析器。 */
const platform = JSON.parse(
    await readFile(
        new URL("../../../packages/contracts/schemas/platform-v1.schema.json", import.meta.url),
    ),
);
const definitions = { ...platform.$defs };
for (const [name, schema] of Object.entries(document.components.schemas)) {
    const normalized = JSON.stringify(schema)
        .replaceAll("#/components/schemas/", "#/$defs/api_")
        .replaceAll("../schemas/platform-v1.schema.json#/$defs/", "#/$defs/");
    definitions["api_" + name] = JSON.parse(normalized);
}
await writeFile(
    new URL("../src/shared/validation.generated.json", import.meta.url),
    JSON.stringify(
        {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            $id: "https://veriq.invalid/desktop-inputs",
            $defs: definitions,
        },
        null,
        4,
    ) + "\n",
);
