import type { DesktopBridge } from "../shared/bridge";
import type { CloudOperation } from "../shared/operations.generated";

/**
 * 将宿主报告句柄投影为按消费速度拉取的标准响应。取消只关闭当前句柄，报告运行本身仍由服务端管理。
 */
export async function openDesktopStream(
    bridge: Pick<DesktopBridge, "streamOpen" | "streamClose" | "streamPull">,
    operation: CloudOperation,
    signal: AbortSignal,
): Promise<Response> {
    signal.throwIfAborted();
    const id = await bridge.streamOpen(operation);
    let closed = false;
    const close = () => {
        if (closed) return;
        closed = true;
        signal.removeEventListener("abort", close);
        void bridge.streamClose(id).catch(() => {});
    };
    // 取消可能发生在 IPC 返回之前，此时不能依赖后续 abort 事件或消费者读取才能释放已经分配的宿主句柄。
    if (signal.aborted) {
        close();
        signal.throwIfAborted();
    }
    signal.addEventListener("abort", close, { once: true });
    const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
            try {
                signal.throwIfAborted();
                const part = await bridge.streamPull(id);
                signal.throwIfAborted();
                if (part.done) {
                    closed = true;
                    signal.removeEventListener("abort", close);
                    controller.close();
                } else if (part.bytes) controller.enqueue(part.bytes);
            } catch (error) {
                close();
                controller.error(error);
            }
        },
        cancel: close,
    });
    return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
}
