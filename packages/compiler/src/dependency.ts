/**
 * 本文件提供编译期依赖与指针工具：含哈希与 JSON Pointer 键转义：并再导出契约侧绑定解析原语（dependency）。
 */

import { createHash } from "node:crypto";
import type { JsonValue, ValueType } from "@veriq/contracts";
/**
 * 公开接口 ValidationIssue 描述编译/校验问题：含 JSON 指针路径、稳定 code 与可读 message。
 */
export interface ValidationIssue {
    path: string;
    code: string;
    message: string;
}
/**
 * 公开常量函数 sha256 计算字节摘要：供编译期完整性核对与 wireId 派生使用，标注导出符号 sha256 供检索。
 */
export const sha256 = (bytes: Uint8Array): string =>
    createHash("sha256").update(bytes).digest("hex");
/**
 * 公开常量函数 pointerKey 按 RFC6901 转义对象键：供拼装 JSON Pointer 段时使用（pointerKey）。
 */
export const pointerKey = (key: string): string =>
    key.replaceAll("~", "~0").replaceAll("/", "~1");
/**
 * 公开常量函数 wireId 由源路径稳定派生标识符：用于生成代码中的变量命名而不暴露原始路径细节（wireId）（wireId）。
 */
export const wireId = (sourcePath: string): string =>
    `v_${sha256(new TextEncoder().encode(sourcePath))}`;
/**
 * 再导出契约包中的 valueType/accepts/resolvePointer/resolveBinding 与 Presence。
 * 保持编译器与运行时绑定语义一致。
 */
export {
    valueType,
    accepts,
    resolvePointer,
    resolveBinding,
} from "@veriq/contracts";
export type { Presence } from "@veriq/contracts";
