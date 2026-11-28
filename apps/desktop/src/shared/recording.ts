import type { PlatformComponents } from "@veriq/contracts";

export type RecordingMode = "record" | "annotate" | "paused";
export type RecordingBounds = { x: number; y: number; width: number; height: number };
export type RecordingOpen = { workspaceId: string; resourceId: string; versionId: string; target?: string };

export type RecordingCandidate = {
    locator: PlatformComponents["schemas"]["LocatorV1"];
    matches: number;
};
export type AnnotationAction = "catalog" | "click" | "fill" | "captureOptions" | "bindColumn" | "extractData";
export type RecordingOption = { label: string; value: string };
export type RecordingTable = { columns: string[]; rows: string[][] };
export const maxRecordingOptions = 200;
export const maxRecordingOptionLength = 256;
type AnnotationRequest = Omit<RecordingArm, "mode"> & { requestId: number };
export type RecordingAnnotationTarget = AnnotationRequest & {
    type: "annotation-target";
    kind: "generic" | "text" | "select" | "table" | "list";
    candidates: RecordingCandidate[];
};
export type RecordingCaptureRequest = AnnotationRequest & { type: "read-options" | "read-table"; captureId: string };
export type RecordingTableReply = AnnotationRequest & {
    type: "annotation-table";
    captureId: string;
    table: RecordingTable | null;
};
export type RecordingOptionsReply = AnnotationRequest & {
    type: "annotation-options";
    captureId: string;
    options: RecordingOption[] | null;
};
export type RecordingNotice =
    | "NAVIGATION_BLOCKED"
    | "FRAME_BLOCKED"
    | "POPUP_BLOCKED"
    | "DOWNLOAD_BLOCKED"
    | "LOAD_FAILED"
    | "DATA_UNAVAILABLE"
    | "OPTIONS_UNAVAILABLE"
    | "VIEW_CLOSED";
export type RecordingNavigationCause = "initial" | "explicit" | "click" | "page";
export type RecordingEvent = { sessionId: string; navigation: number; id: string } & (
    | { type: "click" | "annotation"; candidates: RecordingCandidate[] }
    | {
          type: "annotation-target";
          kind: RecordingAnnotationTarget["kind"];
          actions: AnnotationAction[];
          candidates: RecordingCandidate[];
      }
    | {
          type: "annotation-action";
          targetId: string;
          action: AnnotationAction;
          candidates: RecordingCandidate[];
          options?: RecordingOption[];
          table?: RecordingTable;
      }
    | { type: "fill-pending"; candidates: RecordingCandidate[] }
    | { type: "fill"; candidates: RecordingCandidate[]; value: string }
    | { type: "location"; url: string }
    | { type: "navigation"; path: string; cause?: RecordingNavigationCause }
    | { type: "notice"; code: RecordingNotice }
);
export type RecordingArm = { sessionId: string; navigation: number; mode: RecordingMode; generation: number };
