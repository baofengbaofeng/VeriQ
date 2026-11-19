/**
 * 为 Node 调用方汇集依赖工具、快照分析、产物编译与诊断投影；执行端共享的编译计划类型仍由契约包定义。
 * 分析返回问题与计划，编译要求无问题并提供固定引擎发行输入；诊断投影用于输出受限的结构化失败信息。
 */

export * from "./dependency.js";
export * from "./validate.js";
export * from "./compile.js";
export * from "./diagnostics.js";
