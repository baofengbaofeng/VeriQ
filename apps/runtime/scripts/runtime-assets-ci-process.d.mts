import type { HostBuildInvocation, HostBuildObservation } from "./runtime-payload-entries.ts";

/**
 * 有界 CLI 管理器的声明严格保留直接子进程的全部结算事实，类型适配不会把 close、退出或超时改写成成功；真实实现仍由同名 MJS 负责管道字节上限和关闭期限，调用方必须逐字段检查后才消费输出。
 * 此声明不授权任意后代清理，也不提供可覆盖实际观察对象的宿主后备实现。
 */
export function runBoundedAssetCli(invocation: HostBuildInvocation): Promise<HostBuildObservation>;
