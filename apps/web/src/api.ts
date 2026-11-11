import type { PlatformComponents, PlatformPaths } from "@veriq/contracts";
type Schemas = PlatformComponents["schemas"];
export type User = Schemas["AdminUserDTO"];
export type Session = Schemas["SessionDTO"];
export type AccountSessions = Schemas["AccountSessionsDTO"];
export type ResetLink = Schemas["ResetLinkDTO"];
export type UserListQuery = NonNullable<
  PlatformPaths["/api/v1/admin/users"]["get"]["parameters"]["query"]
>;
export type SessionListQuery = NonNullable<
  PlatformPaths["/api/v1/account/sessions"]["get"]["parameters"]["query"]
>;
function queryString(
  options: Record<string, string | number | boolean | undefined>,
): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(options))
    if (value !== undefined) query.set(key, String(value));
  return query.size ? "?" + query.toString() : "";
}
let csrfToken = "";
export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
    public requestId: string,
  ) {
    super(message);
  }
}
export async function request<T>(
  path: string,
  method = "GET",
  data?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch("/api/v1" + path, {
    method,
    credentials: "same-origin",
    signal,
    headers: {
      "Content-Type": "application/json",
      ...(method !== "GET" ? { "X-CSRF-Token": csrfToken } : {}),
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  const body = await response.json();
  if (response.status === 401)
    window.dispatchEvent(new Event("veriq:session-expired"));
  if (!response.ok)
    throw new ApiError(
      body.code,
      body.message,
      response.status,
      body.requestId,
    );
  if (body.data?.csrfToken) csrfToken = body.data.csrfToken;
  return body.data as T;
}
export const api = {
  setup: () => request<Schemas["SetupDTO"]>("/setup"),
  initialize: (data: Schemas["SetupRequest"]) =>
    request<Schemas["UserDTO"]>("/setup", "POST", data),
  login: (data: Schemas["LoginRequest"]) =>
    request<Session>("/auth/login", "POST", data),
  session: () => request<Session>("/auth/session"),
  logout: () => request<Schemas["Empty"]>("/auth/logout", "POST", {}),
  account: () => request<User>("/account"),
  sessions: (options: SessionListQuery = {}) =>
    request<AccountSessions>("/account/sessions" + queryString({ ...options })),
  revokeOwn: () =>
    request<Schemas["Empty"]>("/account/sessions/revoke", "POST", {}),
  password: (data: Schemas["ChangePasswordRequest"]) =>
    request<Schemas["Empty"]>("/account/password", "POST", data),
  resetRequest: (email: string) =>
    request<Schemas["Empty"]>("/auth/password-reset", "POST", { email }),
  resetConfirm: (data: Schemas["ResetPasswordRequest"]) =>
    request<Schemas["Empty"]>("/auth/password-reset/confirm", "POST", data),
  users: (options: UserListQuery = {}) =>
    request<Schemas["AdminUsersDTO"]>(
      "/admin/users" + queryString({ ...options }),
    ),
  createUser: (data: Schemas["CreateUserRequest"]) =>
    request<User>("/admin/users", "POST", data),
  updateUser: (id: string, data: Schemas["UpdateUserRequest"]) =>
    request<User>(`/admin/users/${id}`, "PATCH", data),
  resetLink: (id: string) =>
    request<ResetLink>(`/admin/users/${id}/reset-link`, "POST", {}),
  revokeUser: (id: string) =>
    request<Schemas["Empty"]>(`/admin/users/${id}/sessions/revoke`, "POST", {}),
  workspaces: (cursor?: string, signal?: AbortSignal) =>
    request<Schemas["WorkspaceDTOPageEnvelope"]["data"]>(
      "/workspaces" + queryString({ cursor }),
      "GET",
      undefined,
      signal,
    ),
  workspace: (id: string, signal?: AbortSignal) =>
    request<Schemas["WorkspaceDTO"]>(
      `/workspaces/${id}`,
      "GET",
      undefined,
      signal,
    ),
  createWorkspace: (data: Schemas["WorkspaceWrite"], signal?: AbortSignal) =>
    request<Schemas["WorkspaceDTO"]>("/workspaces", "POST", data, signal),
  renameWorkspace: (id: string, name: string, signal?: AbortSignal) =>
    request<Schemas["WorkspaceDTO"]>(
      `/workspaces/${id}`,
      "PATCH",
      { name },
      signal,
    ),
  archiveWorkspace: (id: string, signal?: AbortSignal) =>
    request<Schemas["Empty"]>(`/workspaces/${id}`, "DELETE", undefined, signal),
  members: (id: string, cursor?: string, signal?: AbortSignal) =>
    request<Schemas["MemberDTOPageEnvelope"]["data"]>(
      `/workspaces/${id}/members` + queryString({ cursor }),
      "GET",
      undefined,
      signal,
    ),
  updateMember: (
    ws: string,
    id: string,
    data: Schemas["MemberWrite"],
    signal?: AbortSignal,
  ) =>
    request<Schemas["MemberDTO"]>(
      `/workspaces/${ws}/members/${id}`,
      "PUT",
      data,
      signal,
    ),
  removeMember: (ws: string, id: string, signal?: AbortSignal) =>
    request<Schemas["Empty"]>(
      `/workspaces/${ws}/members/${id}`,
      "DELETE",
      undefined,
      signal,
    ),
  invitations: (id: string, cursor?: string, signal?: AbortSignal) =>
    request<Schemas["InvitationSummaryDTOPageEnvelope"]["data"]>(
      `/workspaces/${id}/invitations` + queryString({ cursor }),
      "GET",
      undefined,
      signal,
    ),
  invite: (id: string, data: Schemas["InviteRequest"], signal?: AbortSignal) =>
    request<Schemas["InviteDTO"]>(
      `/workspaces/${id}/invitations`,
      "POST",
      data,
      signal,
    ),
  revokeInvitation: (ws: string, id: string, signal?: AbortSignal) =>
    request<Schemas["Empty"]>(
      `/workspaces/${ws}/invitations/${id}`,
      "DELETE",
      undefined,
      signal,
    ),
  acceptInvitation: (data: Schemas["InvitationAcceptRequest"]) =>
    request<Schemas["UserDTO"]>("/auth/invitations/accept", "POST", data),
};
export type Workspace = Schemas["WorkspaceDTO"];
export type Member = Schemas["MemberDTO"];
