/** Native development transport. Tokens never use URLs, cookies, argv or logs. */
import {
  chmod,
  open,
  lstat,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import envPaths from "env-paths";
import lockfile from "proper-lockfile";
import { validateSchema, type PlatformComponents } from "@veriq/contracts";
type Schemas = PlatformComponents["schemas"];
export type DeviceConfig = Schemas["DeviceCredentialsDTO"] & { server: string };
export type Capabilities = Schemas["RuntimeCapabilitiesV1"];

export function controlOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    !["https:", "http:"].includes(url.protocol) ||
    (url.protocol === "http:" &&
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
  )
    throw new Error(
      "Use an HTTPS control origin (HTTP is allowed only for local development).",
    );
  return url.origin;
}
export class RuntimeError extends Error {
  code: string;
  status: number;
  constructor(code: string, status: number) {
    super(`VeriQ request failed: ${code} (${status})`);
    this.code = code;
    this.status = status;
  }
}
export class RuntimeClient {
  server: string;
  constructor(server: string) {
    this.server = controlOrigin(server);
  }
  async request<T>(
    path: string,
    method = "GET",
    body?: unknown,
    token?: string,
    signal?: AbortSignal,
  ): Promise<T> {
    if (!path.startsWith("/") || path.startsWith("//") || new URL(path, this.server).origin !== this.server)
      throw new RuntimeError("CONTROL_ORIGIN_MISMATCH", 0);
    let response: Response;
    try {
      response = await fetch(this.server + path, {
        method,
        redirect: "error",
        credentials: "omit",
        signal: AbortSignal.any([
          AbortSignal.timeout(15_000),
          ...(signal ? [signal] : []),
        ]),
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: "Bearer " + token } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new RuntimeError(
        signal?.aborted ? "CANCELLED" : "NETWORK_UNAVAILABLE",
        0,
      );
    }
    if (response.status === 204) return undefined as T;
    // Bound the body before parsing, including untrusted proxy/error responses.
    const reader = response.body?.getReader();
    let size = 0;
    const chunks: Uint8Array[] = [];
    if (reader)
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.length;
          if (size > 65536) {
            await reader.cancel();
            throw new Error();
          }
          chunks.push(next.value);
        }
      } catch {
        throw new RuntimeError("INVALID_RESPONSE", response.status);
      }
    let value: { data?: T; code?: unknown };
    try {
      value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new RuntimeError("INVALID_RESPONSE", response.status);
    }
    if (!response.ok) {
      const code =
        typeof value.code === "string" && /^[A-Z_]{1,80}$/.test(value.code)
          ? value.code
          : "REQUEST_FAILED";
      throw new RuntimeError(code, response.status);
    }
    if (value.data === undefined)
      throw new RuntimeError("INVALID_RESPONSE", response.status);
    const schema =
      path.endsWith("/poll") ||
      path.endsWith("/rotate") ||
      path.endsWith("/service")
        ? "DeviceCredentialsDTO"
        : path === "/api/v1/runtime-enrollments"
          ? "EnrollmentDTO"
          : path === "/internal/v1/runtime"
            ? "RuntimeDTO"
            : undefined;
    if (schema && validateSchema(schema, value.data).length)
      throw new RuntimeError("INVALID_RESPONSE", response.status);
    return value.data;
  }
  begin(name: string, capabilities: Capabilities, signal?: AbortSignal) {
    return this.request<Schemas["EnrollmentDTO"]>(
      "/api/v1/runtime-enrollments",
      "POST",
      { name, location: "CONNECTED_LOCAL", capabilities },
      undefined,
      signal,
    );
  }
  inspectDevice(token: string, signal?: AbortSignal) {
    return this.request<Schemas["RuntimeDTO"]>(
      "/internal/v1/runtime",
      "GET",
      undefined,
      token,
      signal,
    );
  }
  poll(deviceCode: string, signal?: AbortSignal) {
    return this.request<Schemas["DeviceCredentialsDTO"]>(
      "/api/v1/runtime-enrollments/poll",
      "POST",
      { deviceCode },
      undefined,
      signal,
    );
  }
  serviceEnroll(
    name: string,
    capabilities: Capabilities,
    token: string,
    sharedWithWorkspace: boolean,
    signal?: AbortSignal,
  ) {
    return this.request<Schemas["DeviceCredentialsDTO"]>(
      "/internal/v1/runtime-enrollments/service",
      "POST",
      { name, capabilities, sharedWithWorkspace },
      token,
      signal,
    );
  }
  rotate(token: string, signal?: AbortSignal) {
    return this.request<Schemas["DeviceCredentialsDTO"]>(
      "/internal/v1/runtime/token/rotate",
      "POST",
      {},
      token,
      signal,
    );
  }
  logout(token: string, signal?: AbortSignal) {
    return this.request<Record<string, never>>(
      "/internal/v1/runtime/logout",
      "POST",
      {},
      token,
      signal,
    );
  }
}

/** Restricted file seam for development; T20 provides the native OS vault. */
export class DeviceStore {
  directory: string;
  constructor(directory = envPaths("veriq", { suffix: "" }).config) {
    this.directory = directory;
  }
  async prepare() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.directory);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("Unsafe device configuration directory");
    await chmod(this.directory, 0o700);
  }
  async load(): Promise<DeviceConfig> {
    const file = join(this.directory, "device.json");
    const info = await lstat(file);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size > 65536 ||
      (process.platform !== "win32" && (info.mode & 0o077) !== 0)
    )
      throw new Error("Unsafe device credential file permissions");
    const value = JSON.parse(await readFile(file, "utf8")) as DeviceConfig;
    controlOrigin(value.server);
    const { server: _, ...receipt } = value;
    if (validateSchema("DeviceCredentialsDTO", receipt).length)
      throw new Error("Invalid device configuration");
    return value;
  }
  async save(config: DeviceConfig) {
    await this.prepare();
    const release = await lockfile.lock(this.directory, { retries: 0 });
    const temporary = join(this.directory, `.device-${randomUUID()}.json`);
    try {
      try {
        await lstat(join(this.directory, "device.json"));
        throw new Error("ALREADY_ENROLLED");
      } catch (error) {
        if (!(
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        ))
          throw error;
      }
      await writeFile(temporary, JSON.stringify(config), {
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporary, join(this.directory, "device.json"));
    } finally {
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
      await release();
    }
  }
  /** Hold the same profile lock throughout pending recovery and atomic replacement. */
  async renew(client: RuntimeClient): Promise<DeviceConfig> {
    await this.prepare();
    const release = await lockfile.lock(this.directory, { retries: 0 });
    const pendingPath = join(this.directory, "rotation.json");
    const atomic = async (path: string, value: unknown) => {
      const temporary = join(this.directory, `.renew-${randomUUID()}.json`);
      try {
        await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx", flush: true });
        await rename(temporary, path);
        const directory = await open(this.directory, "r");
        try { await directory.sync(); } finally { await directory.close(); }
      } finally { await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; }); }
    };
    try {
      const current = await this.load();
      if (current.server !== client.server) throw new Error("DEVICE_PRINCIPAL_CHANGED");
      let pending: { previous: DeviceConfig; clientRequestId: string; replacementToken: string };
      try {
        const info = await lstat(pendingPath);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 65536 || (info.mode & 0o077)) throw new Error("UNSAFE_ROTATION_JOURNAL");
        pending = JSON.parse(await readFile(pendingPath, "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        pending = { previous: current, clientRequestId: randomUUID(), replacementToken: randomBytes(32).toString("base64url") };
        await atomic(pendingPath, pending);
      }
      if (pending.previous.server !== current.server || pending.previous.runnerId !== current.runnerId || pending.previous.workspaceId !== current.workspaceId)
        throw new Error("DEVICE_PRINCIPAL_CHANGED");
      if (current.deviceToken === pending.replacementToken) {
        await unlink(pendingPath);
        return current;
      }
      if (current.deviceToken !== pending.previous.deviceToken) throw new Error("DEVICE_CREDENTIAL_CHANGED");
      const receipt = await client.request<Schemas["DeviceCredentialsDTO"]>("/internal/v1/runtime/token/rotate", "POST", {clientRequestId: pending.clientRequestId, replacementToken: pending.replacementToken}, current.deviceToken);
      if (receipt.runnerId !== current.runnerId || receipt.workspaceId !== current.workspaceId || receipt.deviceToken !== pending.replacementToken)
        throw new Error("DEVICE_PRINCIPAL_CHANGED");
      // Compare again before replacement, even though cooperative writers hold the lock.
      if (JSON.stringify(await this.load()) !== JSON.stringify(current)) throw new Error("DEVICE_CREDENTIAL_CHANGED");
      const replacement = {...current, ...receipt};
      await atomic(join(this.directory, "device.json"), replacement);
      await unlink(pendingPath);
      return replacement;
    } finally { await release(); }
  }
  async ensureStopped() {
    if (await lockfile.check(join(this.directory, "agent-owner")).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return false; throw error; })) throw new Error("AGENT_RUNNING_STOP_FIRST");
  }
  async hasPendingRotation() {
    try { await lstat(join(this.directory, "rotation.json")); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  }
  async remove() {
    await this.prepare();
    const owner = join(this.directory, "agent-owner");
    await mkdir(owner, {recursive: true, mode: 0o700});
    let ownerRelease: () => Promise<void>;
    try { ownerRelease = await lockfile.lock(owner, {retries: 0}); }
    catch { throw new Error("AGENT_RUNNING_STOP_FIRST"); }
    try {
      const release = await lockfile.lock(this.directory, { retries: 0 });
      try {
        // Forget the candidate first: a crash must not revive a logged-out profile.
        await unlink(join(this.directory, "rotation.json")).catch((error: NodeJS.ErrnoException) => {if (error.code !== "ENOENT") throw error;});
        await unlink(join(this.directory, "device.json"));
      } finally { await release(); }
    } finally { await ownerRelease(); }
  }
}
