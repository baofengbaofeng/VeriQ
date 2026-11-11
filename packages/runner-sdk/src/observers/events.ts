import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Dialog, Download, Page } from "@playwright/test";
import type {
  DialogObserverV1,
  NewPageObserverV1,
  DownloadObserverV1,
} from "@veriq/contracts";
import { budget, stringBinding, type StepContext } from "../context.js";
export type EventEvidence =
  | {
      observerId: string;
      kind: "dialog";
      dialogType: string;
      message: string;
      handling: string;
    }
  | { observerId: string; kind: "newPage"; pageKey: string; url: string }
  | {
      observerId: string;
      kind: "download";
      path: string;
      sizeBytes: number;
      suggestedFilename: string;
    };
export interface EventHandle {
  waitFirst(): Promise<EventEvidence>;
  finalize(): Promise<EventEvidence>;
  dispose(): Promise<void>;
}
export function armEvent(
  spec: DialogObserverV1 | NewPageObserverV1 | DownloadObserverV1,
  ctx: StepContext,
): EventHandle {
  if (spec.kind === "download" && !ctx.downloads)
    throw new Error("DOWNLOAD_PROVIDER_REQUIRED");
  if (spec.kind === "newPage" && ctx.pages.has(spec.pageKey))
    throw new Error("DUPLICATE_PAGE_KEY");
  const controller = new AbortController(),
    deadline = Date.now() + budget(ctx, spec.timeoutMs ?? 15000);
  let count = 0,
    disposed = false,
    error: Error | undefined,
    value: EventEvidence | undefined,
    work: Promise<void> | undefined;
  const activeDownloads = new Set<Download>();
  const downloadTasks = new Set<Promise<void>>();
  controller.signal.addEventListener("abort", () => {
    for (const download of activeDownloads)
      void download.cancel().catch(() => {});
  });
  const watchers = new Set<() => void>();
  const notify = () => {
    for (const f of watchers) f();
  };
  let resolvePage: ((page: Page) => void) | undefined,
    rejectPage: ((error: Error) => void) | undefined;
  if (spec.kind === "newPage") {
    const page = new Promise<Page>((resolve, reject) => {
      resolvePage = resolve;
      rejectPage = reject;
    });
    void page.catch(() => {});
    ctx.pages.set(spec.pageKey, page);
  }
  function receive(action: () => Promise<EventEvidence>) {
    count++;
    if (count > 1) error = new Error("AMBIGUOUS_EVENT");
    work = action()
      .then(
        (v) => {
          value = v;
          clearTimeout(timer);
        },
        (e) => {
          error = e instanceof Error ? e : new Error(String(e));
        },
      )
      .finally(notify);
    return work;
  }
  const dialog = (d: Dialog) =>
    receive(async () => {
      if (
        d.type() !== specDialog().dialogType ||
        d.message() !== stringBinding(specDialog().message, ctx)
      ) {
        await d.dismiss();
        throw new Error("DIALOG_MISMATCH");
      }
      const s = specDialog();
      if (s.handling === "dismiss") await d.dismiss();
      else
        await d.accept(
          s.promptText === undefined
            ? undefined
            : stringBinding(s.promptText, ctx),
        );
      return {
        observerId: s.id,
        kind: "dialog",
        dialogType: d.type(),
        message: d.message(),
        handling: s.handling,
      };
    });
  function specDialog() {
    return spec as DialogObserverV1;
  }
  const popup = (p: Page) =>
    receive(async () => {
      resolvePage?.(p);
      await p.waitForLoadState("domcontentloaded", {
        timeout: budget(ctx, deadline - Date.now()),
      });
      return {
        observerId: spec.id,
        kind: "newPage",
        pageKey: (spec as NewPageObserverV1).pageKey,
        url: p.url(),
      };
    });
  const download = (d: Download) => {
    activeDownloads.add(d);
    const task = receive(async () => {
      const directory = ctx.downloads!.directory,
        path = join(directory, `${randomUUID()}.bin`);
      try {
        await mkdir(directory, { recursive: true });
        const stream = await d.createReadStream();
        if (!stream) throw new Error("DOWNLOAD_FAILED");
        let bytes = 0;
        const limit = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            bytes += chunk.length;
            callback(
              bytes > ctx.downloads!.maxBytes
                ? new Error("DOWNLOAD_SIZE_LIMIT")
                : null,
              chunk,
            );
          },
        });
        await pipeline(
          stream,
          limit,
          createWriteStream(path, { flags: "wx", mode: 0o600 }),
          { signal: controller.signal },
        );
        const failure = await d.failure();
        if (failure) throw new Error("DOWNLOAD_FAILED");
        return {
          observerId: spec.id,
          kind: "download",
          path,
          sizeBytes: (await stat(path)).size,
          suggestedFilename: d.suggestedFilename(),
        };
      } catch (e) {
        await d.cancel().catch(() => {});
        await rm(path, { force: true });
        throw e;
      }
    });
    downloadTasks.add(task);
    void task.finally(() => {
      activeDownloads.delete(d);
      downloadTasks.delete(task);
    });
  };
  const abort = () => {
    controller.abort();
    rejectPage?.(new Error("CANCELLED"));
    notify();
  };
  ctx.signal?.addEventListener("abort", abort);
  const timer = setTimeout(
    () => {
      error = new Error("EVENT_TIMEOUT");
      rejectPage?.(error);
      controller.abort();
      notify();
    },
    Math.max(1, deadline - Date.now()),
  );
  const handle: EventHandle = {
    async waitFirst() {
      while (true) {
        if (ctx.signal?.aborted) throw new Error("CANCELLED");
        if (error) throw error;
        if (disposed) throw new Error("OBSERVER_DISPOSED");
        if (value) return value;
        await new Promise<void>((resolve) => {
          const done = () => {
            watchers.delete(done);
            resolve();
          };
          watchers.add(done);
        });
      }
    },
    async finalize() {
      const value = await this.waitFirst();
      if (work) await work;
      if (error) throw error;
      return value;
    },
    async dispose() {
      if (disposed) {
        await Promise.all(downloadTasks);
        return;
      }
      disposed = true;
      rejectPage?.(new Error("OBSERVER_DISPOSED"));
      clearTimeout(timer);
      controller.abort();
      ctx.signal?.removeEventListener("abort", abort);
      ctx.page.off("dialog", dialog);
      if (spec.kind === "dialog") {
        const remaining = ctx.dialogObservers.get(ctx.page)! - 1;
        if (remaining) ctx.dialogObservers.set(ctx.page, remaining);
        else ctx.dialogObservers.delete(ctx.page);
      }
      ctx.page.off("popup", popup);
      ctx.page.off("download", download);
      ctx.registry.remove(handle);
      if (spec.kind === "newPage" && !value) ctx.pages.delete(spec.pageKey);
      notify();
      await Promise.all(downloadTasks);
    },
  };
  if (spec.kind === "dialog") {
    ctx.dialogObservers.set(
      ctx.page,
      (ctx.dialogObservers.get(ctx.page) ?? 0) + 1,
    );
    ctx.page.on("dialog", dialog);
  } else if (spec.kind === "newPage") ctx.page.on("popup", popup);
  else ctx.page.on("download", download);
  ctx.registry.add(handle);
  return handle;
}
