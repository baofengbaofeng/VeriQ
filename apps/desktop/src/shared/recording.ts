import type { PlatformComponents } from "@veriq/contracts";

export type RecordingMode = "record" | "annotate" | "paused";
export type RecordingBounds = { x: number; y: number; width: number; height: number };
export type RecordingOpen = { workspaceId: string; resourceId: string; versionId: string; target?: string };

export type RecordingCandidate = {
    locator: PlatformComponents["schemas"]["LocatorV1"];
    matches: number;
};
export type RecordingNotice =
    | "NAVIGATION_BLOCKED"
    | "FRAME_BLOCKED"
    | "POPUP_BLOCKED"
    | "DOWNLOAD_BLOCKED"
    | "LOAD_FAILED"
    | "VIEW_CLOSED"
    | "PATH_REDACTED";
export type RecordingNavigationCause = "initial" | "explicit" | "click" | "page";
export type RecordingEvent = { sessionId: string; navigation: number; id: string } & (
    | { type: "click" | "annotation"; candidates: RecordingCandidate[] }
    | { type: "navigation"; path: string; cause?: RecordingNavigationCause }
    | { type: "notice"; code: RecordingNotice }
);
export type RecordingArm = { sessionId: string; navigation: number; mode: RecordingMode; generation: number };
