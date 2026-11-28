import { session, WebContentsView, type BrowserWindow, type IpcMainEvent, type Session } from "electron";
import { join } from "node:path";
import { RecordingSession, recordingTarget } from "./recording-session";
import type {
    RecordingBounds,
    RecordingEvent,
    RecordingMode,
    RecordingNavigationCause,
    RecordingNotice,
} from "../shared/recording";

export type RecordingScope = { origin: string; userId: string; workspaceId: string };
type Target = { base: string; approved: string[]; initial?: string };
type Owner = { window: BrowserWindow; scope: RecordingScope };

type NavigationIntent = { cause: "initial" | "explicit" };
type ActiveRecording = {
    owner: Owner;
    view: WebContentsView;
    partition: Session;
    lifecycle: RecordingSession;
    bounds: RecordingBounds | null;
    armed: boolean;
    resolveTarget: (input?: string) => URL;
    replayPath: (url: URL) => string | undefined;
    intent: NavigationIntent | undefined;
    lastClick: number | undefined;
};

/**
 * 已批准的跨源页面可显示地址，但录制的导航步骤只接受环境基准来源内的路径，防止回放改变目标来源。
 */
function replayPath(url: URL, baseOrigin: string): string | undefined {
    if (url.origin !== baseOrigin || url.pathname.startsWith("//")) return;
    return url.href.slice(url.origin.length).replaceAll("{", "%7B").replaceAll("}", "%7D");
}

function sameScope(left: RecordingScope, right: RecordingScope): boolean {
    return left.origin === right.origin && left.userId === right.userId && left.workspaceId === right.workspaceId;
}

/**
 * 单窗口只持有一个视图。宿主自行绑定已认证用户、工作区和来源，并在任一绑定失效时撤销记录能力。
 */
export class RecordingView {
    private active: ActiveRecording | undefined;

    constructor(private readonly preloadDirectory: string) {}

    open(owner: Owner, target: Target): string {
        const resolveTarget = (input?: string) => recordingTarget(target.base, target.approved, input);
        const url = resolveTarget(target.initial);
        const baseOrigin = new URL(target.base).origin;
        this.close();
        const partition = session.fromPartition(`veriq-recording-${crypto.randomUUID()}`, { cache: false });
        partition.setPermissionRequestHandler((_contents, _permission, answer) => answer(false));
        partition.setPermissionCheckHandler(() => false);
        partition.setDevicePermissionHandler(() => false);
        partition.setDisplayMediaRequestHandler((_request, callback) => callback({}));
        const view = new WebContentsView({
            webPreferences: {
                preload: join(this.preloadDirectory, "recording.cjs"),
                session: partition,
                sandbox: true,
                contextIsolation: true,
                nodeIntegration: false,
                nodeIntegrationInSubFrames: false,
                webviewTag: false,
            },
        });
        const contents = view.webContents;
        const lifecycle = new RecordingSession(contents.id);
        lifecycle.setMode("annotate");
        const current: ActiveRecording = {
            owner,
            view,
            partition,
            lifecycle,
            resolveTarget,
            replayPath: (url) => replayPath(url, baseOrigin),
            bounds: null,
            armed: false,
            intent: { cause: "initial" },
            lastClick: undefined,
        };
        this.active = current;
        owner.window.contentView.addChildView(view);
        view.setVisible(false);
        const send = (event: RecordingEvent | undefined) => {
            if (this.active === current && event && !owner.window.isDestroyed())
                owner.window.webContents.send("veriq:recording-notice", event);
        };
        const notice = (code: RecordingNotice) => send(lifecycle.notice(code));
        const permitted = (input: string) => {
            try {
                return resolveTarget(input);
            } catch {
                return undefined;
            }
        };
        const gate = (event: Electron.Event & { url: string; isMainFrame: boolean }) => {
            const destination = permitted(event.url);
            if (!destination || (!event.isMainFrame && destination.origin !== permitted(contents.getURL())?.origin)) {
                event.preventDefault();
                notice(event.isMainFrame ? "NAVIGATION_BLOCKED" : "FRAME_BLOCKED");
            }
        };
        contents.on("will-frame-navigate", gate);
        contents.on("will-redirect", gate);
        partition.webRequest.onBeforeRequest((request, answer) => {
            if (this.active !== current) {
                answer({ cancel: true });
                return;
            }
            const destination = permitted(request.url);
            const permittedFrame =
                request.resourceType !== "subFrame" || destination?.origin === permitted(contents.getURL())?.origin;
            answer({ cancel: !destination || !permittedFrame });
            if ((!destination || !permittedFrame) && ["mainFrame", "subFrame"].includes(request.resourceType))
                notice(request.resourceType === "mainFrame" ? "NAVIGATION_BLOCKED" : "FRAME_BLOCKED");
        });
        partition.on("will-download", (event) => {
            event.preventDefault();
            notice("DOWNLOAD_BLOCKED");
        });
        contents.setWindowOpenHandler(() => {
            notice("POPUP_BLOCKED");
            return { action: "deny" };
        });
        let cause: RecordingNavigationCause | undefined;
        const takeCause = (): RecordingNavigationCause => {
            const related = current.lastClick !== undefined && performance.now() - current.lastClick < 1000;
            const value = current.intent?.cause ?? (related ? "click" : "page");
            current.intent = undefined;
            current.lastClick = undefined;
            return value;
        };
        contents.on("did-start-navigation", (event) => {
            if (!event.isMainFrame) return;
            cause = takeCause();
            if (!event.isSameDocument) {
                lifecycle.beginNavigation();
                view.setVisible(false);
            }
        });
        let lastCommitted: string | undefined;
        const ready = (urlValue: string, report = true) => {
            const finished = permitted(urlValue);
            if (!finished || this.active !== current) return;
            lastCommitted = urlValue;
            lifecycle.finishNavigation(contents.mainFrame);
            this.arm(current);
            this.position(current);
            const navigationCause = cause ?? takeCause();
            cause = undefined;
            send(lifecycle.location(finished.href));
            if (!report) return;
            const path = current.replayPath(finished);
            if (path) send(lifecycle.navigated(path, navigationCause));
        };
        contents.on("did-finish-load", () => ready(contents.getURL()));
        contents.on("did-stop-loading", () => {
            if (!lifecycle.arm && lastCommitted === contents.getURL()) ready(lastCommitted, false);
        });
        contents.on("did-navigate-in-page", (_event, path, isMainFrame) => {
            if (isMainFrame) {
                lifecycle.beginNavigation();
                ready(path);
            }
        });
        contents.on("did-fail-load", (_event, error, _description, _url, isMainFrame) => {
            if (isMainFrame && error !== -3) notice("LOAD_FAILED");
        });
        contents.on("render-process-gone", () => {
            notice("VIEW_CLOSED");
            if (this.active === current) this.close();
        });
        // 将启动交回事件循环，使可信工作区可以先接收会话标识，且关闭时无法启动过期的加载。
        setImmediate(() => {
            if (this.active === current) void contents.loadURL(url.href).catch(() => {});
        });
        return lifecycle.id;
    }

    mode(scope: RecordingScope, id: string, mode: RecordingMode): { path?: string } {
        const active = this.owned(scope, id);
        const pathname =
            mode === "record" && active.lifecycle.arm
                ? active.replayPath(new URL(active.view.webContents.getURL()))
                : undefined;
        if (active.lifecycle.arm?.mode !== mode) {
            active.lifecycle.setMode(mode);
            if (active.lifecycle.arm) this.arm(active);
        }
        return pathname ? { path: pathname } : {};
    }

    bounds(scope: RecordingScope, id: string, bounds: RecordingBounds | null): void {
        const active = this.owned(scope, id);
        active.bounds = bounds;
        this.position(active);
    }

    private position({ owner, view, bounds, lifecycle, armed }: ActiveRecording): void {
        if (!bounds || !lifecycle.arm || !armed) {
            view.setVisible(false);
            if (view.webContents.isFocused() && !owner.window.isDestroyed()) owner.window.webContents.focus();
            return;
        }
        const [width = 0, height = 0] = owner.window.getContentSize();
        const x = Math.min(bounds.x, width);
        const y = Math.min(bounds.y, height);
        const targetWidth = Math.min(bounds.width, width - x);
        const targetHeight = Math.min(bounds.height, height - y);
        if (targetWidth > 0) {
            // 给窄面板中的桌面站点保留约 1000 个 CSS 像素；缩放仅作用于独立录制会话。
            const zoom = Math.min(1, Math.max(0.25, targetWidth / 1000));
            if (Math.abs(view.webContents.getZoomFactor() - zoom) > 0.001) view.webContents.setZoomFactor(zoom);
        }
        view.setBounds({ x, y, width: targetWidth, height: targetHeight });
        view.setVisible(targetWidth > 0 && targetHeight > 0);
    }

    async navigate(scope: RecordingScope, id: string, url: string): Promise<void> {
        const active = this.owned(scope, id);
        const target = active.resolveTarget(url);
        const intent = { cause: "explicit" } as const;
        active.intent = intent;
        try {
            await active.view.webContents.loadURL(target.href);
        } catch {
            if (active.intent === intent) active.intent = undefined;
            throw new Error("RECORDING_LOAD_FAILED");
        }
    }

    acknowledge(scope: RecordingScope | undefined, event: IpcMainEvent, value: unknown): void {
        const active = this.active;
        if (!scope || !active || !sameScope(active.owner.scope, scope)) return;
        if (active.lifecycle.acceptsArm({ contentsId: event.sender.id, frame: event.senderFrame }, value)) {
            active.armed = true;
            this.position(active);
        }
    }

    accept(scope: RecordingScope | undefined, event: IpcMainEvent, payload: unknown): void {
        const active = this.active;
        if (!scope || !active?.armed || !sameScope(active.owner.scope, scope)) return;
        const value = active.lifecycle.acceptEvent(
            {
                contentsId: event.sender.id,
                frame: event.senderFrame,
            },
            payload,
        );
        if (value && !active.owner.window.isDestroyed()) {
            if (value.type === "click") active.lastClick = performance.now();
            if (
                value.type === "annotation-target" ||
                value.type === "annotation-action" ||
                (value.type === "notice" && (value.code === "OPTIONS_UNAVAILABLE" || value.code === "DATA_UNAVAILABLE"))
            )
                active.owner.window.webContents.focus();
            active.owner.window.webContents.send("veriq:recording-notice", value);
        }
    }

    annotationAction(scope: RecordingScope, sessionId: string, targetId: string, action: unknown): void {
        const active = this.owned(scope, sessionId);
        const { window } = active.owner;
        if (!active.armed || window.isDestroyed()) throw new Error("RECORDING_SESSION_DENIED");
        const selection = active.lifecycle.chooseAnnotation(targetId, action);
        if (!selection) throw new Error("RECORDING_ANNOTATION_DENIED");
        if (selection.type === "read-options" || selection.type === "read-table") {
            active.view.webContents.send("veriq:recording-capture", selection);
        } else {
            window.webContents.send("veriq:recording-notice", selection);
        }
    }

    close(scope?: RecordingScope, id?: string): void {
        if (scope && id && this.active?.lifecycle.id !== id) return;
        if (scope && id) this.owned(scope, id);
        const active = this.active;
        this.active = undefined;
        if (!active) return;
        active.lifecycle.close();
        const { owner, view, partition } = active;
        if (!owner.window.isDestroyed()) owner.window.contentView.removeChildView(view);
        const release = () => {
            partition.webRequest.onBeforeRequest(null);
            partition.removeAllListeners("will-download");
            void Promise.allSettled([partition.clearData(), partition.clearCache(), partition.closeAllConnections()]);
        };
        const contents = view.webContents;
        if (contents.isDestroyed()) release();
        else {
            contents.once("destroyed", release);
            contents.close({ waitForBeforeUnload: false });
        }
    }

    private owned(scope: RecordingScope, id: string) {
        const active = this.active;
        if (!active || active.lifecycle.id !== id || !sameScope(active.owner.scope, scope))
            throw new Error("RECORDING_SESSION_DENIED");
        return active;
    }

    private arm(active: ActiveRecording): void {
        active.armed = false;
        this.position(active);
        try {
            active.view.webContents.mainFrame.send("veriq:recording-arm", active.lifecycle.arm);
        } catch {
            // frame 可能恰在下一次导航中失效，此次记录权限已撤销，下一文档在加载完成后重新获得代次。
        }
    }
}
