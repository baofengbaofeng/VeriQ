/**
 * 压缩文档正例失败时记录网络事件与认证阶段的次序，所有输入字段在进入缓冲区前转换为固定标签。
 * 旁路只关联本次独占浏览器上下文的协议事件，真实网络命令始终使用调用者原有的参数和返回值。
 */
import { Buffer } from "node:buffer";
import type { BrowserContext, CDPSession } from "@playwright/test";

const commands = [
    "Page.getFrameTree",
    "Page.enable",
    "Fetch.enable",
    "Fetch.continueRequest",
    "Fetch.failRequest",
    "Fetch.takeResponseBodyAsStream",
    "IO.read",
    "IO.close",
    "Fetch.continueResponse",
    "Fetch.fulfillRequest",
];
const paths = new Map([
    ["/protected", "PROTECTED"],
    ["/login", "LOGIN"],
    ["/submit", "SUBMIT"],
    ["/callback", "CALLBACK"],
    ["/me", "IDENTITY"],
    ["/demo.js", "SCRIPT"],
    ["/favicon.ico", "FAVICON"],
    ["/unrelated", "UNRELATED"],
]);
const resources = ["Document", "Script", "Image", "Fetch", "XHR", "Stylesheet", "Other"];
const maxEvents = 48;
const maxIds = 128;
const maxOutputBytes = 12 * 1024;

type Fields = Record<string, string | number | boolean>;
type CallObserver = { resolved?(value: unknown): void; rejected?(error: unknown): void };

function fields(value: unknown): Record<string, unknown> {
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function label(value: unknown, permitted: string[]) {
    return typeof value === "string" && permitted.includes(value) ? value : "OTHER";
}

/**
 * 识别已知的协议失败类型但不保存异常的描述或任意类名，未知错误保留一个可与命令关联的固定分类。
 */
function errorCategory(error: unknown) {
    const name = fields(error).name;
    if (name === "TargetClosedError") return "TARGET_CLOSED";
    if (name === "TimeoutError") return "TIMEOUT";
    if (name === "ProtocolError") return "PROTOCOL";
    return "OTHER";
}

export function createSsoObservation(app: string, idp: string) {
    const events: Fields[] = [];
    const requests = new Map<string, number>();
    const streams = new Map<string, { request: number }>();
    const restore: Array<() => void> = [];
    let mainFrame: string | undefined;
    let peakRetainedIds = 0;
    let sequence = 0;
    let currentStage = "NOT_STARTED";
    let droppedEvents = 0;
    let droppedIds = 0;
    let observationErrors = 0;
    let frozen = false;
    let active = true;
    let sessionAttached = false;

    function safe(fn: () => void) {
        try {
            fn();
        } catch {
            observationErrors++;
        }
    }

    function record(event: string, details: Fields = {}) {
        if (frozen || !active) return;
        if (events.length === maxEvents) {
            events.shift();
            droppedEvents++;
        }
        events.push({ seq: ++sequence, event, ...details });
    }

    function retainedIds() {
        return requests.size + streams.size + Number(mainFrame !== undefined);
    }

    function canRetain(value: unknown, replacing = false): value is string {
        if (typeof value !== "string") return false;
        if (!value || value.length > 256 || (!replacing && retainedIds() >= maxIds)) {
            droppedIds++;
            return false;
        }
        return true;
    }

    function ordinal(value: unknown) {
        if (typeof value !== "string") return 0;
        const known = requests.get(value);
        if (known !== undefined) return known;
        if (!canRetain(value)) return 0;
        const n = requests.size + 1;
        requests.set(value, n);
        peakRetainedIds = Math.max(peakRetainedIds, retainedIds());
        return n;
    }

    function address(value: unknown) {
        const url = typeof value === "string" ? URL.parse(value) : null;
        return {
            site: url?.origin === app ? "APP" : url?.origin === idp ? "IDP" : "OTHER",
            path: paths.get(url?.pathname ?? "") ?? "OTHER",
        };
    }

    /**
     * 原方法同步调用且只调用一次，独立监听原 Promise 完成或拒绝并原样将它交还调用者，释放时还原自有属性描述符。
     */
    function observeMethod(owner: object, key: string, start: (args: unknown[]) => CallObserver) {
        const descriptor = Object.getOwnPropertyDescriptor(owner, key);
        const original = Reflect.get(owner, key) as (...args: unknown[]) => Promise<unknown>;
        const wrapper = new Proxy(original, {
            apply(target, receiver, args: unknown[]) {
                if (!active || frozen) return Reflect.apply(target, receiver, args);
                let observer: CallObserver = {};
                safe(() => {
                    observer = start(args);
                });
                let pending: Promise<unknown>;
                try {
                    pending = Reflect.apply(target, receiver, args);
                } catch (error) {
                    safe(() => observer.rejected?.(error));
                    throw error;
                }
                safe(() => {
                    void pending.then(
                        (value) => {
                            if (active && !frozen) safe(() => observer.resolved?.(value));
                        },
                        (error: unknown) => {
                            if (active && !frozen) safe(() => observer.rejected?.(error));
                        },
                    );
                });
                return pending;
            },
        });
        Object.defineProperty(owner, key, { configurable: true, writable: true, value: wrapper });
        restore.push(() => {
            if (Reflect.get(owner, key) !== wrapper) return;
            if (descriptor) Object.defineProperty(owner, key, descriptor);
            else Reflect.deleteProperty(owner, key);
        });
    }

    function command(args: unknown[]): CallObserver {
        const name = label(args[0], commands);
        const params = fields(args[1]);
        const stream = typeof params.handle === "string" ? streams.get(params.handle) : undefined;
        const request = typeof params.handle === "string" ? (stream?.request ?? 0) : ordinal(params.requestId);
        record("send", { name, request });
        return commandResult(name, request, stream);
    }

    function commandResult(name: string, request: number, stream: { request: number } | undefined): CallObserver {
        return {
            resolved(value) {
                const result = fields(value);
                if (name === "Page.getFrameTree") {
                    mainFrame = undefined;
                    const id = fields(fields(result.frameTree).frame).id;
                    if (canRetain(id)) mainFrame = id;
                }
                if (name === "Fetch.takeResponseBodyAsStream" && typeof result.stream === "string") {
                    if (request === 0) droppedIds++;
                    else if (canRetain(result.stream, streams.has(result.stream)))
                        streams.set(result.stream, { request });
                }
                // 等真实关闭成功才释放槽位，未完成的命令只保留数值关联，不另存原始流句柄。
                if (name === "IO.close" && stream) {
                    for (const [key, entry] of streams)
                        if (entry === stream) {
                            streams.delete(key);
                            break;
                        }
                }
                peakRetainedIds = Math.max(peakRetainedIds, retainedIds());
                if (name === "IO.read")
                    record("read", {
                        request,
                        eof: result.eof === true,
                        bytes:
                            typeof result.data === "string"
                                ? Buffer.byteLength(result.data, result.base64Encoded === true ? "base64" : "utf8")
                                : -1,
                    });
                else record("resolved", { name, request });
            },
            rejected(error) {
                record("commandError", { name, request, category: errorCategory(error) });
            },
        };
    }

    function attachSession(session: CDPSession) {
        if (sessionAttached) return;
        sessionAttached = true;
        const paused = (event: unknown) =>
            safe(() => {
                if (!active || frozen) return;
                const entry = fields(event),
                    req = fields(entry.request);
                const status = entry.responseStatusCode;
                record("paused", {
                    request: ordinal(entry.requestId),
                    redirect: typeof entry.redirectedRequestId === "string",
                    parent: ordinal(entry.redirectedRequestId),
                    main: typeof mainFrame === "string" && mainFrame === entry.frameId,
                    ...address(req.url),
                    method: label(req.method, ["GET", "HEAD", "POST"]),
                    resource: label(entry.resourceType, resources),
                    status:
                        typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599
                            ? status
                            : 0,
                    responseError: entry.responseErrorReason !== undefined,
                });
            });
        const navigated = (event: unknown) =>
            safe(() => {
                if (!active || frozen) return;
                const frame = fields(fields(event).frame);
                record("frameNavigated", {
                    main: typeof mainFrame === "string" && mainFrame === frame.id,
                    ...address(frame.url),
                });
            });
        session.on("Fetch.requestPaused", paused);
        restore.push(() => {
            session.off("Fetch.requestPaused", paused);
        });
        session.on("Page.frameNavigated", navigated);
        restore.push(() => {
            session.off("Page.frameNavigated", navigated);
        });
        observeMethod(session, "send", command);
    }

    return {
        attach(context: BrowserContext) {
            safe(() =>
                observeMethod(context, "newCDPSession", () => ({
                    resolved(value) {
                        attachSession(value as CDPSession);
                    },
                    rejected(error) {
                        record("sessionError", { category: errorCategory(error) });
                    },
                })),
            );
        },
        stage(value: string) {
            if (!active || frozen) return;
            currentStage = label(value, [
                "START",
                "IDP",
                "SUBMISSION_PREPARED",
                "CALLBACK",
                "IDENTITY",
                "AUTHENTICATED",
            ]);
            record("stage", { name: currentStage });
        },
        denied() {
            if (active && !frozen) {
                record("firstDenied", { stage: currentStage });
                frozen = true;
            }
        },
        dispose() {
            active = false;
            while (restore.length) {
                const undo = restore.pop();
                if (undo) safe(undo);
            }
            requests.clear();
            streams.clear();
            mainFrame = undefined;
        },
        report() {
            const kept = [...events];
            let dropped = droppedEvents;
            for (;;) {
                const output = JSON.stringify({
                    type: "SSO_TEST_TRACE",
                    firstDenied: frozen,
                    stage: currentStage,
                    droppedEvents: dropped,
                    droppedIds,
                    peakRetainedIds,
                    observationErrors,
                    events: kept,
                });
                if (Buffer.byteLength(output) <= maxOutputBytes || !kept.length) return output;
                kept.shift();
                dropped++;
            }
        },
    };
}
