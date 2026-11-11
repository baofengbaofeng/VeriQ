import type { PlatformComponents } from "@veriq/contracts";
import { request, ApiError } from "../../api";
type S = PlatformComponents["schemas"];
export type Bundle = S["BundleDTO"];
export interface BundleAdapter {
  list(
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<{ items: Bundle[]; nextCursor: string | null }>;
  export(selection: S["BundleCreate"], signal?: AbortSignal): Promise<Bundle>;
  download(id: string, signal?: AbortSignal): Promise<Blob>;
}
export class CloudBundleAdapter implements BundleAdapter {
  constructor(readonly workspaceId: string) {}
  private base() {
    return `/workspaces/${this.workspaceId}/bundles`;
  }
  list = (cursor?: string, signal?: AbortSignal) =>
    request<{ items: Bundle[]; nextCursor: string | null }>(
      this.base() + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""),
      "GET",
      undefined,
      signal,
    );
  export = (selection: S["BundleCreate"], signal?: AbortSignal) =>
    request<Bundle>(this.base(), "POST", selection, signal);
  async download(id: string, signal?: AbortSignal) {
    const response = await fetch(
      `/api/v1${this.base()}/${encodeURIComponent(id)}/download`,
      { credentials: "same-origin", signal, redirect: "error" },
    );
    if (!response.ok) {
      const body = await response.json();
      if (response.status === 401)
        window.dispatchEvent(new Event("veriq:session-expired"));
      throw new ApiError(
        body.code,
        body.message,
        response.status,
        body.requestId,
      );
    }
    const blob = await response.blob();
    if (blob.size > 64 * 1024 * 1024) throw new Error("BUNDLE_TOO_LARGE");
    return blob;
  }
}
/** Desktop supplies a narrow host transport; verification and credentials stay in main. */
export class LocalBundleAdapter implements BundleAdapter {
  constructor(private host: BundleAdapter) {}
  list = (cursor?: string, signal?: AbortSignal) =>
    this.host.list(cursor, signal);
  export = (selection: S["BundleCreate"], signal?: AbortSignal) =>
    this.host.export(selection, signal);
  download = (id: string, signal?: AbortSignal) =>
    this.host.download(id, signal);
}
