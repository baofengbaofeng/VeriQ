import type { PlatformComponents } from "@veriq/contracts";
type Schemas = PlatformComponents["schemas"];
export type User = Schemas["AdminUserDTO"];
export type Session = Schemas["SessionDTO"];
export type AccountSessions = Schemas["AccountSessionsDTO"];
export type ResetLink = Schemas["ResetLinkDTO"];
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
): Promise<T> {
  const response = await fetch("/api/v1" + path, {
    method,
    credentials: "same-origin",
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
  sessions: () => request<AccountSessions>("/account/sessions"),
  revokeOwn: () =>
    request<Schemas["Empty"]>("/account/sessions/revoke", "POST", {}),
  password: (data: Schemas["ChangePasswordRequest"]) =>
    request<Schemas["Empty"]>("/account/password", "POST", data),
  resetRequest: (email: string) =>
    request<Schemas["Empty"]>("/auth/password-reset", "POST", { email }),
  resetConfirm: (data: Schemas["ResetPasswordRequest"]) =>
    request<Schemas["Empty"]>("/auth/password-reset/confirm", "POST", data),
  users: () => request<Schemas["AdminUsersDTO"]>("/admin/users"),
  createUser: (data: Schemas["CreateUserRequest"]) =>
    request<User>("/admin/users", "POST", data),
  updateUser: (id: string, data: Schemas["UpdateUserRequest"]) =>
    request<User>(`/admin/users/${id}`, "PATCH", data),
  resetLink: (id: string) =>
    request<ResetLink>(`/admin/users/${id}/reset-link`, "POST", {}),
  revokeUser: (id: string) =>
    request<Schemas["Empty"]>(`/admin/users/${id}/sessions/revoke`, "POST", {}),
};
