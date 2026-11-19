import type { HostBuildObservation } from "./runtime-payload-entries.ts";

/**
 * 观察器声明只描述既有 JavaScript 模块返回的原始制品身份与累计数量，不改变扫描实现或扩大任何预算；片段仍须由消费者从刚
 * 写出的真实位置读取并逐项核长度和摘要，声明本身不提供可信扫描结果。
 */
export function collectLayoutMetadata(options: {
    root: string;
    evidenceDir: string;
    workspaceRoots: readonly { path: string; sourcePath: string }[];
    limits?: Record<string, number>;
    deadlineMs?: number;
}): Promise<{
    schemaVersion: number;
    totals: Record<string, number>;
    artifacts: { kind: string; path: string; bytes: number; sha256: string }[];
}>;

/**
 * 命令分类沿用既有有界 CLI 的全部正交成功条件，关闭未知、截断、超时、信号或非零退出均不能成为 PASS；此函数声明不启动进
 * 程、不修改观测结果，也不代表任意子孙进程已被操作系统清理。
 */
export function classifyCommandResult(result: HostBuildObservation): "PASS" | "FAIL";
