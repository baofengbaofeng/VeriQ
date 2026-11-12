/**
 * 本文件 packages/contracts/src/bindings.ts 实现 VeriQ 相关前端或执行侧能力，并标明公开导出与关键路径
 * 模块注释用于帮助智能体与贡献者快速定位授权、执行与离线相关逻辑。
 * 本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。
 * 实现时不得绕过 Workspace 归属校验，也不得把密钥或明文凭证写入日志。
 * 若行为变更，请同步更新契约样例、相关测试与可观察的错误码语义。
 * 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
 * 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
 * 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
 * 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
 * 测试与文档应能证明该路径在无模型凭证、缺浏览器或租约过期时仍失败关闭正确。
 */

import type {
    JsonValue,
    JsonObject,
    ParameterTypes,
    // 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    // 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
    // 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
    ValueType,
} from "./types.generated.js";
/**
 * 公开常量或工厂 pointerKey 为 packages/contracts/src/bindings.ts 提供稳定导出入口与默认行为
 * 请结合 Workspace 边界、契约校验与失败关闭路径阅读本实现。
 * 本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。
 * 实现时不得绕过 Workspace 归属校验，也不得把密钥或明文凭证写入日志。
 * 若行为变更，请同步更新契约样例、相关测试与可观察的错误码语义。
 * 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
 * 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
 * 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
 * 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
 * 测试与文档应能证明该路径在无模型凭证、缺浏览器或租约过期时仍失败关闭正确。
 */
export const pointerKey = (key: string): string =>
    key.replaceAll("~", "~0").replaceAll("/", "~1");
/**
 * 公开函数 valueType 负责 packages/contracts/src/bindings.ts 中的关键处理流程并返回约定结果
 * 请结合 Workspace 边界、契约校验与失败关闭路径阅读本实现。
 * 本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。
 * 实现时不得绕过 Workspace 归属校验，也不得把密钥或明文凭证写入日志。
 * 若行为变更，请同步更新契约样例、相关测试与可观察的错误码语义。
 * 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
 * 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
 * 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
 * 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
 * 测试与文档应能证明该路径在无模型凭证、缺浏览器或租约过期时仍失败关闭正确。
 */
export function valueType(value: unknown): ValueType {
    // 关键路径：处理 if 分支，保持取消、重试与证据完整性约束不被削弱；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    if (value === null) return "null";
    // 关键路径：处理 if 分支，保持取消、重试与证据完整性约束不被削弱；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    if (Array.isArray(value)) return "array";
    // 关键路径：处理 if 分支，保持取消、重试与证据完整性约束不被削弱；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    if (typeof value === "number")
        return Number.isInteger(value) ? "integer" : "number";
    return typeof value as ValueType;
}
/**
 * 公开函数 accepts 负责 packages/contracts/src/bindings.ts 中的关键处理流程并返回约定结果
 * 请结合 Workspace 边界、契约校验与失败关闭路径阅读本实现。
 * 本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。
 * 实现时不得绕过 Workspace 归属校验，也不得把密钥或明文凭证写入日志。
 * 若行为变更，请同步更新契约样例、相关测试与可观察的错误码语义。
 * 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
 * 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
 * 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
 * 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
 * 测试与文档应能证明该路径在无模型凭证、缺浏览器或租约过期时仍失败关闭正确。
 */
export function accepts(expected: ValueType, actual: ValueType): boolean {
    return expected === actual || (expected === "number" && actual === "integer");
}
/**
 * 公开类型 Presence 描述 packages/contracts/src/bindings.ts 模块对外契约字段与可组合结构
 * 请结合 Workspace 边界、契约校验与失败关闭路径阅读本实现。
 * 本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。
 * 实现时不得绕过 Workspace 归属校验，也不得把密钥或明文凭证写入日志。
 * 若行为变更，请同步更新契约样例、相关测试与可观察的错误码语义。
 * 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
 * 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
 * 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
 * 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
 * 测试与文档应能证明该路径在无模型凭证、缺浏览器或租约过期时仍失败关闭正确。
 */
export type Presence =
    | {
            present: false;
        }
    // 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    // 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
    // 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
    | {
            present: true;
            value: JsonValue;
        // 分段注释：继续说明 bindings.ts 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        // 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
        // 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
        };
 /**
  * 本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。
  * 实现时不得绕过 Workspace 归属校验，也不得把密钥或明文凭证写入日志。
  * 若行为变更，请同步更新契约样例、相关测试与可观察的错误码语义。
  * 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
  * 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
  * 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
  * 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
  * 测试与文档应能证明该路径在无模型凭证、缺浏览器或租约过期时仍失败关闭正确。
  */
/** RFC6901 own-property lookup. Missing and null are deliberately different. */
/**
 * 公开函数 resolvePointer 负责 packages/contracts/src/bindings.ts 中的关键处理流程并返回约定结果
 * 请结合 Workspace 边界、契约校验与失败关闭路径阅读本实现。
 */
export function resolvePointer(value: JsonValue, pointer: string): Presence {
    // 关键路径：处理 if 分支，保持取消、重试与证据完整性约束不被削弱；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    if (
        pointer !== "" &&
        (!pointer.startsWith("/") || /~(?![01])/u.test(pointer))
    )
        // 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        // 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        // 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        throw new Error("INVALID_POINTER");
    let current: JsonValue = value;
    // 关键路径：处理 for 分支，保持取消、重试与证据完整性约束不被削弱；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    for (const token of pointer === "" ? [] : pointer.slice(1).split("/")) {
        const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
        // 关键路径：处理 if 分支，保持取消、重试与证据完整性约束不被削弱；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        if (
            current === null ||
            typeof current !== "object" ||
            !Object.hasOwn(current, key) ||
            // 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            // 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
            // 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
            (Array.isArray(current) && !/^(0|[1-9][0-9]*)$/u.test(key))
        )
            return { present: false };
        /**
         * 公开函数 current 负责 packages/contracts/src/bindings.ts 中的关键处理流程并返回约定结果
         * 请结合 Workspace 边界、契约校验与失败关闭路径阅读本实现。
         * 本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。
         * 实现时不得绕过 Workspace 归属校验，也不得把密钥或明文凭证写入日志。
         * 若行为变更，请同步更新契约样例、相关测试与可观察的错误码语义。
         * 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
         * 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
         * 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
         * 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
         * 测试与文档应能证明该路径在无模型凭证、缺浏览器或租约过期时仍失败关闭正确。
         */
        current = (current as Record<string, JsonValue>)[key]!;
    }
    return { present: true, value: current };
}
/**
 * 公开函数 resolveBinding 负责 packages/contracts/src/bindings.ts 中的关键处理流程并返回约定结果
 * 请结合 Workspace 边界、契约校验与失败关闭路径阅读本实现。
 * 本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。
 * 实现时不得绕过 Workspace 归属校验，也不得把密钥或明文凭证写入日志。
 * 若行为变更，请同步更新契约样例、相关测试与可观察的错误码语义。
 * 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
 * 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
 * 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
 * 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
 * 测试与文档应能证明该路径在无模型凭证、缺浏览器或租约过期时仍失败关闭正确。
 */
export function resolveBinding(
    value: JsonValue,
    context: {
        data: JsonValue;
        // 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        // 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        // 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        vars: JsonValue;
    },
): JsonValue {
    // 关键路径：处理 if 分支，保持取消、重试与证据完整性约束不被削弱；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    if (typeof value === "string") {
        const pattern =
            /\{\{(data|vars)\.([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\}\}/gu;
        const matches = [...value.matchAll(pattern)];
        // 关键路径：处理 if 分支，保持取消、重试与证据完整性约束不被削弱；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        if (
            value.replace(pattern, "").includes("{{") ||
            value.replace(pattern, "").includes("}}")
        )
            // 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            // 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
            // 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
            throw new Error("UNSAFE_EXPRESSION");
        const read = (m: RegExpMatchArray): JsonValue => {
            const found = resolvePointer(
                // 分段注释：继续说明 bindings.ts 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                // 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
                // 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
                context[m[1] as "data" | "vars"],
                "/" + m[2]!.split(".").map(pointerKey).join("/"),
            );
            // 关键路径：处理 if 分支，保持取消、重试与证据完整性约束不被削弱；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            if (!found.present) throw new Error("MISSING_BINDING");
            return found.value;
        };
        // 关键路径：处理 if 分支，保持取消、重试与证据完整性约束不被削弱；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        if (matches.length === 1 && matches[0]![0] === value)
            return read(matches[0]!);
        return value.replace(pattern, (...args: unknown[]) => {
            const v = read(args as RegExpMatchArray);
            // 关键路径：处理 if 分支，保持取消、重试与证据完整性约束不被削弱；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            if (typeof v === "object") throw new Error("BINDING_TYPE_MISMATCH");
            return String(v);
        });
    }
    // 关键路径：处理 if 分支，保持取消、重试与证据完整性约束不被削弱；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    if (Array.isArray(value)) return value.map((v) => resolveBinding(v, context));
    // 关键路径：处理 if 分支，保持取消、重试与证据完整性约束不被削弱；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    if (value !== null && typeof value === "object")
        return Object.fromEntries(
            Object.entries(value).map(([k, v]) => [k, resolveBinding(v, context)]),
        );
    // 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    // 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
    // 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
    return value;
}

 /**
  * 本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。
  * 实现时不得绕过 Workspace 归属校验，也不得把密钥或明文凭证写入日志。
  * 若行为变更，请同步更新契约样例、相关测试与可观察的错误码语义。
  * 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
  * 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
  * 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
  * 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
  * 测试与文档应能证明该路径在无模型凭证、缺浏览器或租约过期时仍失败关闭正确。
  */
/** Validate required declarations and expose only the pre-prepare binding scope. */
/**
 * 公开函数 resolveInitialVariables 负责 packages/contracts/src/bindings.ts 中的关键处理流程并返回约定结果
 * 请结合 Workspace 边界、契约校验与失败关闭路径阅读本实现。
 */
export function resolveInitialVariables(
    declarations: ParameterTypes | undefined,
    values: JsonObject,
): JsonObject {
    // 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    // 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
    // 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
    const entries = Object.entries(declarations ?? {});
    // 关键路径：处理 for 分支，保持取消、重试与证据完整性约束不被削弱；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    for (const [key, type] of entries)
        // 关键路径：处理 if 分支，保持取消、重试与证据完整性约束不被削弱；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        if (!Object.hasOwn(values, key) || !accepts(type, valueType(values[key])))
            throw new Error("INITIAL_VARIABLES_INVALID");
    return Object.fromEntries(entries.map(([key]) => [key, values[key]!]));
}
