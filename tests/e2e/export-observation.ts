import { _electron } from "../../apps/desktop/tests/fixtures";

type Desktop = Awaited<ReturnType<typeof _electron.launch>>;
type DesktopPage = Awaited<ReturnType<Desktop["firstWindow"]>>;

/** 导出诊断只观察当前测试空间的普通会话请求和真实按钮事件，不读请求正文、认证头、下载地址或业务响应；每类记录都有数量上限，原键盘动作、请求预算和成功断言继续由调用方执行。 */
export async function observeExport(electron: Desktop, page: DesktopPage, endpoint: string) {
    await electron.evaluate(({ session }, endpoint) => {
        const transport = session.fromPartition("persist:veriq-host").webRequest;
        const filter = { urls: [endpoint] };
        let count = 0;
        const record = (
            event: string,
            id: number,
            method: string,
            status?: number,
            error?: string,
        ) => {
            if (count++ >= 16) return;
            console.error(
                "Bundle export request observation",
                JSON.stringify({
                    event,
                    at: Date.now(),
                    id,
                    method,
                    status,
                    error: error && /^net::ERR_[A-Z_]+$/.test(error) ? error : undefined,
                }),
            );
        };
        // 此专用宿主分区在生产代码中没有这些被动事件监听；不注册可取消请求的 before 事件，不替换 fetch 或 IPC，也不接触 renderer 分区的外网拒绝规则。
        transport.onSendHeaders(filter, (details) => record("sent", details.id, details.method));
        transport.onResponseStarted(filter, (details) =>
            record("response", details.id, details.method, details.statusCode),
        );
        transport.onCompleted(filter, (details) =>
            record("completed", details.id, details.method, details.statusCode),
        );
        transport.onErrorOccurred(filter, (details) =>
            record("error", details.id, details.method, undefined, details.error),
        );
    }, endpoint);
    const logInput = (message: { text(): string }) => {
        if (message.text().startsWith("Bundle export input observation "))
            console.log(message.text());
    };
    page.on("console", logInput);
    const input = await page.getByTestId("bundle-export").evaluateHandle((button) => {
        let count = 0;
        const record = (event: Event) => {
            if (count++ >= 8) return;
            const key =
                event instanceof KeyboardEvent
                    ? event.key === "Enter"
                        ? "Enter"
                        : "other"
                    : undefined;
            console.info(
                "Bundle export input observation " +
                    JSON.stringify({
                        event: event.type,
                        at: Date.now(),
                        trusted: event.isTrusted,
                        key,
                        disabled: (button as HTMLButtonElement).disabled,
                        focused: document.activeElement === button,
                    }),
            );
        };
        button.addEventListener("keydown", record, { passive: true });
        button.addEventListener("click", record, { passive: true });
        return () => {
            button.removeEventListener("keydown", record);
            button.removeEventListener("click", record);
        };
    });
    // 只记录可核对的布尔状态和有限数量，不输出表单值或错误消息；检查失败后的 finally 快照仍可区分按钮忙碌、请求错误提示与列表尚未刷新，不能据快照自动重试写操作。
    const snapshot = async (stage: "before-focus" | "focused" | "after-enter" | "settled") => {
        const state = await page.evaluate(() => {
            const button = document.querySelector<HTMLButtonElement>(
                '[data-testid="bundle-export"]',
            );
            const environment = document.querySelector<HTMLSelectElement>(
                '[data-testid="bundle-environment-version"]',
            );
            const statuses = [...document.querySelectorAll('[role="status"]')].map(
                (node) => node.textContent ?? "",
            );
            return {
                disabled: button?.disabled ?? null,
                focused: !!button && document.activeElement === button,
                environmentSelected: !!environment?.value,
                selectedCases: document.querySelectorAll('[data-testid="bundle-selected-case"]')
                    .length,
                items: document.querySelectorAll('[data-testid="bundle-item"]').length,
                alert: !!document.querySelector('[role="alert"]'),
                working: statuses.some((text) => text.includes("Working")),
                exported: statuses.some((text) => text.includes("Exported")),
            };
        });
        console.log(
            "Bundle export DOM observation",
            JSON.stringify({ stage, at: Date.now(), ...state }),
        );
    };
    return {
        snapshot,
        /** 当前测试独占这四个原本未使用的宿主事件槽，结束时只撤销本次注册的槽和精确 DOM/console 回调；未来若生产新增同类监听，须先迁移诊断，不能覆盖已有监听来获取证据。 */
        async dispose() {
            page.off("console", logInput);
            const results = await Promise.allSettled([
                input.evaluate((remove) => remove()).finally(() => input.dispose()),
                electron.evaluate(({ session }) => {
                    const transport = session.fromPartition("persist:veriq-host").webRequest;
                    transport.onSendHeaders(null);
                    transport.onResponseStarted(null);
                    transport.onCompleted(null);
                    transport.onErrorOccurred(null);
                }),
            ]);
            if (results.some((result) => result.status === "rejected"))
                throw new Error("EXPORT_OBSERVATION_CLEANUP_FAILED");
        },
    };
}
