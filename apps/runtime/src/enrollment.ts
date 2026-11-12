/**
 * 本文件实现设备注册、令牌轮换与配置持久化：审批码轮询与服务账号注册共用受控文件存储：令牌不进 URL/日志（enrollment）。
 */

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
/**
 * 公开类型 DeviceConfig 保存已注册设备的控制 Origin、设备令牌与能力声明等私有配置字段（DeviceConfig）。
 */
export type DeviceConfig = Schemas["DeviceCredentialsDTO"] & { server: string };
/**
 * 公开类型 Capabilities 描述设备申报的执行能力：仅作注册与认领匹配：不构成信任证明（Capabilities）。
 */
export type Capabilities = Schemas["RuntimeCapabilitiesV1"];

/**
 * 公开函数 controlOrigin 规范化并校验控制服务 Origin：拒绝用户信息、异常端口与非 http(s) scheme（controlOrigin）。
 */
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
/**
 * 公开类 RuntimeError 表示控制面请求失败：携带稳定 code 与可选 HTTP 状态：供 CLI/Agent 映射用户可见错误（RuntimeError）。
 */
export class RuntimeError extends Error {
    code: string;
    status: number;
    constructor(code: string, status: number) {
        super(`VeriQ request failed: ${code} (${status})`);
        this.code = code;
        this.status = status;
    }
}
/**
 * 公开类 RuntimeClient 封装设备注册与令牌相关的控制面 HTTP 调用：强制同源并省略 Cookie（RuntimeClient）。
 */
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
    /**
     * 公开方法 begin 发起人工审批注册：返回 deviceCode 等轮询材料：密钥不进 URL，标注导出 begin。
     */
    begin(name: string, capabilities: Capabilities, signal?: AbortSignal) {
        return this.request<Schemas["EnrollmentDTO"]>(
            "/api/v1/runtime-enrollments",
            "POST",
            { name, location: "CONNECTED_LOCAL", capabilities },
            undefined,
            signal,
        );
    }
    /**
     * 公开方法 inspectDevice 用设备令牌查询当前设备视图：供续期与诊断使用（inspectDevice）（inspectDevice）。
     */
    inspectDevice(token: string, signal?: AbortSignal) {
        return this.request<Schemas["RuntimeDTO"]>(
            "/internal/v1/runtime",
            "GET",
            undefined,
            token,
            signal,
        );
    }
    /**
     * 公开方法 poll 轮询人工审批结果：成功后取回设备令牌：过期或拒绝映射稳定错误码（poll），说明 poll 在 enrollment 中的专属行为（poll）。
     */
    poll(deviceCode: string, signal?: AbortSignal) {
        return this.request<Schemas["DeviceCredentialsDTO"]>(
            "/api/v1/runtime-enrollments/poll",
            "POST",
            { deviceCode },
            undefined,
            signal,
        );
    }
    /**
     * 公开方法 serviceEnroll 使用服务账号令牌直接注册设备：跳过人工审批码：仍写入同一私有配置边界（serviceEnroll）。
     */
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
    /**
     * 公开方法 rotate 轮换设备令牌：返回新凭证供 DeviceStore 原子替换：旧令牌随后失效（rotate）（rotate）。
     */
    rotate(token: string, signal?: AbortSignal) {
        return this.request<Schemas["DeviceCredentialsDTO"]>(
            "/internal/v1/runtime/token/rotate",
            "POST",
            {},
            token,
            signal,
        );
    }
    /**
     * 公开方法 logout 向控制面注销设备令牌：本机删除配置由 DeviceStore.remove 负责（logout）。
     */
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

/**
 * 公开类 DeviceStore 以排他文件缝持久化 DeviceConfig：支持续期、停机检查与轮换候选恢复（DeviceStore）。
 */
export class DeviceStore {
    directory: string;
    constructor(directory = envPaths("veriq", { suffix: "" }).config) {
        this.directory = directory;
    }
    /**
     * 公开方法 prepare 创建私有配置目录并准备设备文件锁：供 Agent 启动前调用，标注导出符号 prepare 供检索。
     */
    async prepare() {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        const info = await lstat(this.directory);
        if (!info.isDirectory() || info.isSymbolicLink())
            throw new Error("Unsafe device configuration directory");
        await chmod(this.directory, 0o700);
    }
    /**
     * 公开方法 load 读取本机 DeviceConfig：文件缺失或损坏时失败关闭：不返回部分令牌，标注导出符号 load。
     */
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
    /**
     * 公开方法 save 原子写入 DeviceConfig：保持 0600 权限：避免半写状态被并发读者看到，标注 save。
     */
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
    /**
     * 公开方法 renew 在需要时轮换设备令牌并原子保存：恢复未完成的轮换候选：防止双主凭证，标注导出符号 renew 供检索。
     */
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
    /**
     * 公开方法 ensureStopped 确认本机 Agent 控制通道已停止：避免在旧进程仍存活时覆盖配置（ensureStopped）。
     */
    async ensureStopped() {
        if (await lockfile.check(join(this.directory, "agent-owner")).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return false; throw error; })) throw new Error("AGENT_RUNNING_STOP_FIRST");
    }
    /**
     * 公开方法 hasPendingRotation 检测是否存在未完成的令牌轮换候选：供启动恢复路径决定续写策略（hasPendingRotation）。
     */
    async hasPendingRotation() {
        try { await lstat(join(this.directory, "rotation.json")); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
    }
    /**
     * 公开方法 remove 删除本机设备配置：不自动清除离线信任根：显式删档才移除签发者绑定，标注导出符号 remove 供检索。
     */
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
