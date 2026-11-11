import type { PlatformComponents } from "@veriq/contracts";
import { request } from "../../api";
type S = PlatformComponents["schemas"];
export type Provider = S["ProviderDTO"];
export type Generation = S["GenerationDTO"];
export type GenerationRequest = S["GenerationRequest"];
export interface AiAdapter {
  resource(id: string, signal?: AbortSignal): Promise<S["ResourceDTO"]>;
  providers(
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<S["ProviderDTOPageEnvelope"]["data"]>;
  save(
    data: S["ProviderWrite"],
    id?: string,
    signal?: AbortSignal,
  ): Promise<Provider>;
  remove(id: string, signal?: AbortSignal): Promise<unknown>;
  test(
    id: string,
    requestId: string,
    signal?: AbortSignal,
  ): Promise<Generation>;
  preview(
    data: GenerationRequest,
    signal?: AbortSignal,
  ): Promise<S["AiContextDTO"]>;
  generate(data: GenerationRequest, signal?: AbortSignal): Promise<Generation>;
  history(
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<S["GenerationDTOPageEnvelope"]["data"]>;
  get(id: string, signal?: AbortSignal): Promise<Generation>;
  review(
    id: string,
    data: S["GenerationReview"],
    signal?: AbortSignal,
  ): Promise<Generation>;
  cancel(id: string, signal?: AbortSignal): Promise<Generation>;
}
export class CloudAiAdapter implements AiAdapter {
  constructor(readonly workspaceId: string) {}
  resource = (id: string, signal?: AbortSignal) =>
    request<S["ResourceDTO"]>(
      "/workspaces/" + this.workspaceId + "/resources/" + id,
      "GET",
      undefined,
      signal,
    );
  private base = () => "/workspaces/" + this.workspaceId + "/ai";
  providers = (cursor?: string, signal?: AbortSignal) =>
    request<S["ProviderDTOPageEnvelope"]["data"]>(
      this.base() +
        "/providers" +
        (cursor ? "?cursor=" + encodeURIComponent(cursor) : ""),
      "GET",
      undefined,
      signal,
    );
  save = (data: S["ProviderWrite"], id?: string, signal?: AbortSignal) =>
    request<Provider>(
      this.base() + "/providers" + (id ? "/" + id : ""),
      id ? "PUT" : "POST",
      data,
      signal,
    );
  remove = (id: string, signal?: AbortSignal) =>
    request(this.base() + "/providers/" + id, "DELETE", undefined, signal);
  test = (id: string, requestId: string, signal?: AbortSignal) =>
    request<Generation>(
      this.base() + "/providers/" + id + "/connection-tests",
      "POST",
      { requestId },
      signal,
    );
  preview = (data: GenerationRequest, signal?: AbortSignal) =>
    request<S["AiContextDTO"]>(this.base() + "/context", "POST", data, signal);
  generate = (data: GenerationRequest, signal?: AbortSignal) =>
    request<Generation>(this.base() + "/generations", "POST", data, signal);
  history = (cursor?: string, signal?: AbortSignal) =>
    request<S["GenerationDTOPageEnvelope"]["data"]>(
      this.base() +
        "/generations" +
        (cursor ? "?cursor=" + encodeURIComponent(cursor) : ""),
      "GET",
      undefined,
      signal,
    );
  get = (id: string, signal?: AbortSignal) =>
    request<Generation>(
      this.base() + "/generations/" + id,
      "GET",
      undefined,
      signal,
    );
  review = (id: string, data: S["GenerationReview"], signal?: AbortSignal) =>
    request<Generation>(
      this.base() + "/generations/" + id + "/review",
      "POST",
      data,
      signal,
    );
  cancel = (id: string, signal?: AbortSignal) =>
    request<Generation>(
      this.base() + "/generations/" + id + "/cancel",
      "POST",
      undefined,
      signal,
    );
}
/** Desktop hosts supply a trusted typed bridge; no renderer key read or arbitrary IPC. */
export class LocalAiAdapter implements AiAdapter {
  constructor(private readonly bridge: AiAdapter) {}
  resource: AiAdapter["resource"] = (...args) => this.bridge.resource(...args);
  providers: AiAdapter["providers"] = (...args) =>
    this.bridge.providers(...args);
  save: AiAdapter["save"] = (...args) => this.bridge.save(...args);
  remove: AiAdapter["remove"] = (...args) => this.bridge.remove(...args);
  test: AiAdapter["test"] = (...args) => this.bridge.test(...args);
  preview: AiAdapter["preview"] = (...args) => this.bridge.preview(...args);
  generate: AiAdapter["generate"] = (...args) => this.bridge.generate(...args);
  history: AiAdapter["history"] = (...args) => this.bridge.history(...args);
  get: AiAdapter["get"] = (...args) => this.bridge.get(...args);
  review: AiAdapter["review"] = (...args) => this.bridge.review(...args);
  cancel: AiAdapter["cancel"] = (...args) => this.bridge.cancel(...args);
}
