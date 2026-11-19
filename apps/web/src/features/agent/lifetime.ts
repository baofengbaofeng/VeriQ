/**
 * 用真实挂载效果管理会话请求所有权，React 严格模式重放后使用同一界面的新控制器，旧回调仍保留自己的取消信号。
 */
import { useEffect, useState } from "react";

type Lifetime = { parent?: AbortSignal; signal: AbortSignal };

/**
 * 返回已提交的存活信号，调用方在父级切换或首次效果设置前不挂载查询。取消父级同时中止其全部在途子请求。
 */
export function useAgentLifetime(parent?: AbortSignal): AbortSignal | undefined {
    const [lifetime, setLifetime] = useState<Lifetime>();
    useEffect(() => {
        const controller = new AbortController();
        const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
        setLifetime({ parent, signal });
        return () => controller.abort();
    }, [parent]);
    if (!lifetime || lifetime.parent !== parent || lifetime.signal.aborted) return undefined;
    return lifetime.signal;
}
