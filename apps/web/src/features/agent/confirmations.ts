/**
 * 用户审阅的提议类型决定所需工作区角色，文字确认再按服务端支持的固定短语收窄可选择的操作范围。
 */
import type { Workspace } from "../../api";
import type { AgentSchemas } from "./adapters";

type Action = AgentSchemas["AgentProposal"]["type"];
const edit = ["OWNER", "ADMIN", "EDITOR"];
const execute = ["OWNER", "ADMIN", "EDITOR", "EXECUTOR"];
const roles: Record<Action, readonly string[]> = {
    SAVE_PLAN: edit,
    SAVE_RESOURCE_DRAFT: edit,
    SAVE_RESOURCE_DRAFTS: edit,
    VALIDATE_RESOURCE: edit,
    PUBLISH_RESOURCE: ["OWNER", "ADMIN"],
    RUN_ONCE: execute,
    TRIGGER_PLAN: execute,
    CANCEL_RUN: execute,
    RERUN_RUN: execute,
};

export function canConfirmAgentAction(role: Workspace["role"], action?: Action) {
    return !!action && roles[action]?.includes(role);
}

const anyAction = () => true;
const draft = (action: Action) => action === "SAVE_RESOURCE_DRAFT" || action === "SAVE_RESOURCE_DRAFTS";
const save = (action: Action) => action === "SAVE_PLAN" || draft(action);
const run = (action: Action) => action === "RUN_ONCE" || action === "TRIGGER_PLAN";
const phrases = new Map<string, (action: Action) => boolean>([
    ["confirm", anyAction],
    ["confirm action", anyAction],
    ["确认", anyAction],
    ["确认操作", anyAction],
    ["confirm plan", (action) => action === "SAVE_PLAN"],
    ["confirm save", save],
    ["确认保存", save],
    ["confirm draft", draft],
    ["确认保存草稿", draft],
    ["confirm run", run],
    ["确认执行", run],
    ["确认运行", run],
]);

export function agentConfirmation(text: string) {
    return phrases.get(
        text
            .trim()
            .toLowerCase()
            .replace(/[.!。！]+$/, ""),
    );
}
