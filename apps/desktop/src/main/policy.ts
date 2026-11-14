import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import schema from "../shared/validation.generated.json" with { type: "json" };
import catalog from "../shared/operations.generated.json" with { type: "json" };

/** 云端请求策略只产生固定控制 Origin 下的相对路由，输出结构不携带任意请求头或目标地址；正文仍须通过共享契约校验，后续传输才能附加宿主会话。 */
export interface ResolvedOperation {
    path: string;
    method: string;
    kind: "json" | "stream" | "binary" | "source";
    data?: unknown;
    idempotencyKey?: string;
}

type Rule = {
    path: string;
    method: string;
    ids: string[];
    queries: Record<string, Record<string, unknown>>;
    request: string | null;
    idempotency: boolean;
    kind: string;
};
const rules: Record<string, Rule> = catalog;
const validator = new Ajv2020({ strict: true, allErrors: true });
addFormats.default(validator);
validator.addSchema(schema);
/** 宿主正文校验使用从 OpenAPI 生成的命名空间定义，只有明确存在的模式才会被调用；验证结果用于拒绝不合法的输入，不会修改正文或自动删除调用者的未知字段。 */
export const validateSchema = (name: string, value: unknown) =>
    validator.getSchema(`${schema.$id}#/$defs/api_${name}`)!(value) ? [] : ["INVALID_INPUT"];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 渲染端输入只能是普通键值对象，数组与特殊原型都不是合法 IPC 信封；显式限制键集合可以阻止隐藏的路径、Cookie 和请求头绕过固定操作映射。 */
export function object(value: unknown, keys?: readonly string[]): Record<string, unknown> {
    if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
        (keys && Object.keys(value).some((key) => !keys.includes(key)))
    )
        throw new Error("IPC_PAYLOAD_INVALID");
    return value as Record<string, unknown>;
}

/** 查询参数按生成操作描述逐项恢复布尔、整数或引用模式，未知类型退回有界无控制字符文本；序列化使用 URLSearchParams 完成转义，调用方不能以查询字符串夹带另一条路径。 */
function queryValue(value: unknown, schema: Record<string, unknown>): string {
    if (schema.$ref && typeof schema.$ref === "string") {
        if (validateSchema(schema.$ref.split("/").at(-1)!, value).length)
            throw new Error("IPC_PAYLOAD_INVALID");
    } else if (schema.enum) {
        if (!(schema.enum as unknown[]).includes(value)) throw new Error("IPC_PAYLOAD_INVALID");
    } else if (schema.type === "integer") {
        if (
            !Number.isSafeInteger(value) ||
            Number(value) < Number(schema.minimum ?? 0) ||
            Number(value) > Number(schema.maximum ?? 10000)
        )
            throw new Error("IPC_PAYLOAD_INVALID");
    } else if (schema.type === "boolean") {
        if (typeof value !== "boolean") throw new Error("IPC_PAYLOAD_INVALID");
    } else if (
        typeof value !== "string" ||
        value.length > 4096 ||
        [...value].some((character) => character.charCodeAt(0) < 32)
    ) {
        throw new Error("IPC_PAYLOAD_INVALID");
    }
    return String(value);
}

/** 操作解析先检查名称和正文结构，再绑定当前工作区并填充固定模板；调用者即使知道另一个空间的 UUID，也不能让当前窗口向那个空间发送资源请求。 */
export function resolveOperation(value: unknown, workspace: string | undefined): ResolvedOperation {
    const input = object(value, ["operation", "params", "query", "data", "idempotencyKey"]);
    if (typeof input.operation !== "string" || !Object.hasOwn(rules, input.operation))
        throw new Error("IPC_OPERATION_DENIED");
    const rule = rules[input.operation]!;
    const params = input.params === undefined ? {} : object(input.params, rule.ids);
    let path = rule.path;
    for (const id of rule.ids) {
        const item = params[id];
        if (
            typeof item !== "string" ||
            !(id === "secretRef" ? /^[A-Za-z_][A-Za-z0-9_-]{0,159}$/.test(item) : uuid.test(item))
        )
            throw new Error("IPC_PAYLOAD_INVALID");
        if (id === "workspaceId" && item !== workspace) throw new Error("WORKSPACE_SCOPE_MISMATCH");
        path = path.replace(`{${id}}`, encodeURIComponent(item));
    }
    const query = input.query === undefined ? {} : object(input.query, Object.keys(rule.queries));
    const search = new URLSearchParams();
    for (const [key, item] of Object.entries(query))
        search.set(key, queryValue(item, rule.queries[key]!));
    if (search.size) path += "?" + search.toString();

    // 正文类型来自生成器读取的共享契约，缺失、超大或模式不允许的额外字段均在网络调用前拒绝；通过校验只说明输入形状有效，不替代服务端的当前角色和业务状态检查。
    // GET 操作不能夹带正文，避免读取操作被不透明数据改变含义。
    // 幂等键独立于请求头，以专门字段暴露给有限的导出操作。
    if (rule.request ? validateSchema(rule.request, input.data).length : input.data !== undefined)
        throw new Error("IPC_PAYLOAD_INVALID");
    if (JSON.stringify(input).length > 1024 * 1024) throw new Error("IPC_PAYLOAD_LIMIT");
    if (rule.idempotency) {
        if (
            typeof input.idempotencyKey !== "string" ||
            !(
                input.idempotencyKey.length >= 1 &&
                input.idempotencyKey.length <= 128 &&
                [...input.idempotencyKey].every(
                    (character) => character.charCodeAt(0) >= 33 && character.charCodeAt(0) <= 126,
                )
            )
        )
            throw new Error("IPC_PAYLOAD_INVALID");
    } else if (input.idempotencyKey !== undefined) throw new Error("IPC_PAYLOAD_INVALID");
    if (!["json", "stream", "binary", "source"].includes(rule.kind))
        throw new Error("IPC_OPERATION_DENIED");
    return {
        path,
        method: rule.method,
        kind: rule.kind as ResolvedOperation["kind"],
        ...(input.data === undefined ? {} : { data: input.data }),
        ...(rule.idempotency ? { idempotencyKey: String(input.idempotencyKey) } : {}),
    };
}

/** 返回值投影只在对应 OpenAPI 模式完成实际校验后建立类型，尤其认证 DTO 不能在删去 CSRF 后再冒充完整 SessionDTO；调用方需要显式构造安全的公开会话形状。 */
export function parseSchema<
    Name extends keyof import("@veriq/contracts").PlatformComponents["schemas"],
>(name: Name, value: unknown): import("@veriq/contracts").PlatformComponents["schemas"][Name] {
    if (validateSchema(name, value).length) throw new Error("INVALID_HOST_RESPONSE");
    return value as import("@veriq/contracts").PlatformComponents["schemas"][Name];
}
