/**
 * 用真实挂载效果管理会话请求所有权，React 严格模式重放后使用同一界面的新控制器，旧回调仍保留自己的取消信号。
 */
import { useEffect, useState } from "react";
import { inheritAgentFormSignal } from "./agent-form-origin";

type Lifetime = { parent?: AbortSignal; signal: AbortSignal; generation: number };

/**
 * 返回已提交的存活信号，调用方在父级切换或首次效果设置前不挂载查询。代次可用于重建持有旧信号的查询视图。
 */
export function useRequestLifetime(parent?: AbortSignal): Lifetime | undefined {
    const [lifetime, setLifetime] = useState<Lifetime>();
    useEffect(() => {
        const controller = new AbortController();
        const signal = parent
            ? inheritAgentFormSignal(AbortSignal.any([parent, controller.signal]), parent)
            : controller.signal;
        setLifetime((previous) => ({ parent, signal, generation: (previous?.generation ?? 0) + 1 }));
        return () => controller.abort();
    }, [parent]);
    if (!lifetime || lifetime.parent !== parent || lifetime.signal.aborted) return undefined;
    return lifetime;
}
