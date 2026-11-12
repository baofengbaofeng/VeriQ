import type {
  PlatformComponents,
  AuthAdapterConfigV1,
  JsonObject,
} from "@veriq/contracts";
import { request } from "../../api";
type S = PlatformComponents["schemas"];
export type CredentialSummary = S["CredentialDTO"];
export type AdapterSummary = S["AuthAdapterDTO"];
export interface IdentityAdapter {
  credentials(
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<S["CredentialListDTO"]>;
  adapters(
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<S["AuthAdapterListDTO"]>;
  createAdapter(
    configuration: AuthAdapterConfigV1,
    signal?: AbortSignal,
  ): Promise<AdapterSummary>;
  revokeAdapter(id: string, signal?: AbortSignal): Promise<AdapterSummary>;
  credential(
    secretRef: string,
    value: JsonObject,
    allowedIdentityIds: string[],
    rotate: boolean,
    signal?: AbortSignal,
  ): Promise<CredentialSummary>;
  revokeCredential(
    ref: string,
    id: string,
    signal?: AbortSignal,
  ): Promise<CredentialSummary>;
}
export class CloudIdentityAdapter implements IdentityAdapter {
  constructor(private workspaceId: string) {}
  private base(path: string) {
    return `/workspaces/${this.workspaceId}/${path}`;
  }
  credentials = (cursor?: string, signal?: AbortSignal) =>
    request<S["CredentialListDTO"]>(
      this.base("credentials") +
        (cursor ? "?cursor=" + encodeURIComponent(cursor) : ""),
      "GET",
      undefined,
      signal,
    );
  adapters = (cursor?: string, signal?: AbortSignal) =>
    request<S["AuthAdapterListDTO"]>(
      this.base("auth-adapters") +
        (cursor ? "?cursor=" + encodeURIComponent(cursor) : ""),
      "GET",
      undefined,
      signal,
    );
  createAdapter = (configuration: AuthAdapterConfigV1, signal?: AbortSignal) =>
    request<AdapterSummary>(
      this.base("auth-adapters"),
      "POST",
      { configuration },
      signal,
    );
  revokeAdapter = (id: string, signal?: AbortSignal) =>
    request<AdapterSummary>(
      this.base(`auth-adapters/${encodeURIComponent(id)}/revoke`),
      "POST",
      {},
      signal,
    );
  credential = (
    secretRef: string,
    value: JsonObject,
    allowedIdentityIds: string[],
    rotate: boolean,
    signal?: AbortSignal,
  ) =>
    request<CredentialSummary>(
      this.base(
        rotate
          ? `credentials/${encodeURIComponent(secretRef)}/versions`
          : "credentials",
      ),
      "POST",
      { ...(rotate ? {} : { secretRef }), value, allowedIdentityIds },
      signal,
    );
  revokeCredential = (ref: string, id: string, signal?: AbortSignal) =>
    request<CredentialSummary>(
      this.base(
        `credentials/${encodeURIComponent(ref)}/versions/${encodeURIComponent(id)}/revoke`,
      ),
      "POST",
      {},
      signal,
    );
}
