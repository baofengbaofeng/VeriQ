/**
 * 表单来源属于发起请求的信号，不随窗口焦点、全局路由或并行的 Agent 消息变化。
 */
import type { PlatformComponents } from "@veriq/contracts";

type Capability = PlatformComponents["schemas"]["AgentWorkspaceCapability"];
const formOrigins = new WeakMap<AbortSignal, { turnId: string; capability: Capability }>();
const id = "[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}";
const workspace = `/workspaces/${id}`;
const resourceRoot = `${workspace}/resources`;
const credentialRoot = `${workspace}/credentials`;
const runtime = `${workspace}/runtimes/${id}`;

function writes(...patterns: string[]): RegExp {
    return RegExp(`^(?:${patterns.join("|")})$`);
}

const resources = writes(
    `POST ${resourceRoot}(?:/dataset-copies|/${id}/(?:validate|publish))?`,
    `PUT ${resourceRoot}/${id}/draft`,
    `PATCH ${resourceRoot}/${id}`,
);
const allowedWrites: Partial<Record<Capability, RegExp>> = {
    ENVIRONMENT: resources,
    FIXTURE: resources,
    HTTP_DATASET: resources,
    AUTH_CREDENTIALS: writes(
        `POST ${credentialRoot}(?:/[A-Za-z_][A-Za-z0-9_-]{0,159}/versions(?:/${id}/revoke)?)?`,
        `POST ${workspace}/auth-adapters(?:/${id}/revoke)?`,
    ),
    DEVICE_ACCESS: writes(
        `POST /runtime-enrollments/${id}/approve`,
        `PUT ${runtime}/(?:grants|trust)`,
        `POST ${runtime}/revoke`,
    ),
    DEVICE_CREDENTIAL_DELIVERY: writes(`PUT ${runtime}/credential-delivery`),
    CI_PLAN_TOKENS: writes(`POST ${workspace}/service-accounts(?:/${id}/(?:disable|tokens(?:/${id}/revoke)?))?`),
    WORKSPACE_MEMBERS: writes(
        `(?:PUT|DELETE) ${workspace}/members/${id}`,
        `POST ${workspace}/invitations`,
        `DELETE ${workspace}/invitations/${id}`,
    ),
    AI_PROVIDERS: writes(`POST ${workspace}/ai/providers`, `(?:PUT|DELETE) ${workspace}/ai/providers/${id}`),
    NOTIFICATION_INBOX: writes(`POST /notifications/${id}/(?:read|accept)`),
    WORKSPACE_ARCHIVE: writes(`DELETE ${workspace}`),
};

export function scopeAgentFormSignal(parent: AbortSignal, turnId: string, capability: Capability): AbortSignal {
    const signal = AbortSignal.any([parent]);
    formOrigins.set(signal, { turnId, capability });
    return signal;
}

export function inheritAgentFormSignal(signal: AbortSignal, source?: AbortSignal): AbortSignal {
    const origin = source && formOrigins.get(source);
    if (origin) formOrigins.set(signal, origin);
    return signal;
}

export function agentFormRequestHeader(path: string, method: string, signal?: AbortSignal): Record<string, string> {
    const origin = signal && formOrigins.get(signal);
    if (origin && allowedWrites[origin.capability]?.test(`${method} ${path.split("?")[0]}`)) {
        return { "X-VeriQ-Agent-Form": origin.turnId };
    }
    return {};
}
