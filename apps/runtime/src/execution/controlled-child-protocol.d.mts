import type { BigIntStats } from "node:fs";

/** VeriQ 观察身份绑定不可复用的命令 slot 和代际，描述符槽位只在激活时出现而不参与持久身份；这些字段不代表任何停止回执，也不表达任意后代的内核清理范围。 */
export interface ObserverBinding {
    version: 1;
    attemptId: string;
    ownerGeneration: number;
    commandSlot: string;
    nonce: string;
}

/** 已结清对象保留按构造递增的 slot 与实际退出字段，PID 只提供诊断而不得作为补登记或发信号的依据；signal 与 exitCode 的互斥由运行时协议检查保证。 */
export interface ObservedObject {
    slot: number;
    pid: number;
    exitCode: number | null;
    signal: string | null;
}

/** 协议资源上限同时约束写者和最终读取者，限制包含换行符在内的单帧字节、完整文件、帧数和构造对象数，使损坏文件不能导致无界分配或无限等待。 */
export const LIMITS: Readonly<{ frameBytes: number; fileBytes: number; records: number; objects: number }>;

/** 期望绑定通过精确字段与身份类型检查后复制成快照，调用者不得通过后续修改原对象改变观察身份；验证失败采用固定英文错误而不把原始字段拼进错误文本。 */
export function validateBinding(value: unknown): ObserverBinding;

/** 激活解析只接受 compact stringify 往返一致的严格 JSON，并把子 CLI 的目标 stdio 槽号独立返回；格式错误必须由 preload 转为专用退出而不能作为未激活处理。 */
export function parseActivation(raw: string): { binding: ObserverBinding; fd: number };

/** 同一已开描述符的普通文件、精确权限及当前用户检查不替代父目录安全和发布持久性；Windows 或无法核实 Unix 用户的系统必须显式失败而不假造 ACL 能力。 */
export function inspectJournalFd(fd: number, requireEmpty?: boolean): BigIntStats;

/** 纯日志验证只提供结构化对象事实以便直接负例和父侧最终组合使用，调用者不能凭此函数或临时 EOF 宣称 CLI 退出；只有真实 ChildProcess 观察接口可以提供最终结果。 */
export function validateJournal(bytes: Uint8Array, expectedBinding: ObserverBinding): { objects: ObservedObject[] };
