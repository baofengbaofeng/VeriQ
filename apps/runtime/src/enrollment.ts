/**
 * 本文件实现设备注册、令牌轮换与配置持久化：审批码轮询与服务账号注册共用受控文件存储：令牌不进 URL/日志（enrollment）。
 */

/** 设备级凭证只通过受控请求正文和私有配置传递，不进入 URL、Cookie、命令参数或日志；开发与安装宿主共享校验和轮换协议，平台差异仅限本机文件权限与原子提交实现。 */
import { chmod, open, lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join, basename, dirname } from "node:path";
import { privateDirectory, readBoundedFile, removePrivate } from "./offline/config.ts";
import { randomBytes, randomUUID } from "node:crypto";
import envPaths from "env-paths";
import lockfile from "proper-lockfile";
import { VaultFiles } from "./credentials/files.ts";
import {
    CredentialProfile,
    type CredentialOptions,
    type CredentialTransaction,
    type Rotation,
} from "./credentials/profile.ts";
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
        (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
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
        if (
            !path.startsWith("/") ||
            path.startsWith("//") ||
            new URL(path, this.server).origin !== this.server
        )
            throw new RuntimeError("CONTROL_ORIGIN_MISMATCH", 0);
        let response: Response;
        try {
            response = await fetch(this.server + path, {
                method,
                redirect: "error",
                credentials: "omit",
                signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]),
                headers: {
                    "Content-Type": "application/json",
                    ...(token ? { Authorization: "Bearer " + token } : {}),
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
        } catch {
            throw new RuntimeError(signal?.aborted ? "CANCELLED" : "NETWORK_UNAVAILABLE", 0);
        }
        if (response.status === 204) return undefined as T;
        // 控制面响应在解析前按实际传输字节限制为六万五千五百三十六，代理和错误正文也受同一限制；达到上限即取消 reader 并返回固定错误，避免把秘密响应或无限输入转交日志和解析器。
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
        if (value.data === undefined) throw new RuntimeError("INVALID_RESPONSE", response.status);
        const schema =
            path.endsWith("/poll") || path.endsWith("/rotate") || path.endsWith("/service")
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
    private profile?: CredentialProfile;
    constructor(directory = envPaths("veriq", { suffix: "" }).config, options?: CredentialOptions) {
        this.directory = directory;
        if (options) this.profile = new CredentialProfile(directory, options);
    }
    /** 用户显式请求迁移时委托同一凭据上下文取得停止所有权并核验全部旧用途，返回值不包含秘密；没有安全上下文的开发调用不能把这次请求解释为明文模式认可或自动选择另一种后端。 */
    async migrateCredentials(): Promise<void> {
        if (!this.profile) throw new Error("VAULT_CONTEXT_REQUIRED");
        await this.profile.migrate();
    }
    /** 用户明确恢复未完成初始化时复用系统后端和持续停止所有权，只处理没有任何业务密文的初始档案；活动密钥缺失、残留数据、冲突或系统不可用仍拒绝，调用方不会取得密钥或自动回退到明文。 */
    async recoverCredentialInitialization(): Promise<void> {
        if (!this.profile) throw new Error("VAULT_CONTEXT_REQUIRED");
        await this.profile.recoverInitialization();
    }
    /**
     * 公开方法 prepare 创建私有配置目录并准备设备文件锁：供 Agent 启动前调用，标注导出符号 prepare 供检索。
     */
    async prepare() {
        if (this.profile) {
            const files = await VaultFiles.acquire(this.directory);
            await files.close();
            return;
        }
        if (process.platform === "win32") {
            await privateDirectory(this.directory);
            return;
        }
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
        if (this.profile)
            return this.profile.transaction(async (tx) => {
                const value = await tx.device();
                controlOrigin(value.server);
                const { server: _, ...receipt } = value;
                if (validateSchema("DeviceCredentialsDTO", receipt).length)
                    throw new Error("Invalid device configuration");
                return value;
            });
        const file = join(this.directory, "device.json");
        let value: DeviceConfig;
        if (process.platform === "win32") {
            value = JSON.parse(
                (await readBoundedFile(file, 65536, true)).toString("utf8"),
            ) as DeviceConfig;
        } else {
            const info = await lstat(file);
            if (
                !info.isFile() ||
                info.isSymbolicLink() ||
                info.size > 65536 ||
                (info.mode & 0o077) !== 0
            )
                throw new Error("Unsafe device credential file permissions");
            value = JSON.parse(await readFile(file, "utf8")) as DeviceConfig;
        }
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
        if (this.profile) return this.profile.transaction((tx) => tx.saveDevice(config, true));
        await this.prepare();
        const release = await lockfile.lock(this.directory, {
            retries: 0,
            ...(process.platform === "win32"
                ? { lockfilePath: join(this.directory, ".device.lock") }
                : {}),
        });
        /** Windows 初次注册使用已持有父目录下的独占私有创建，目录内合作锁同样从私有父项继承；已有对象不被收紧或覆盖，原生明确的存在错误仍映射为原先的已注册状态。 */
        if (process.platform === "win32") {
            try {
                const value = JSON.stringify(config);
                if (Buffer.byteLength(value) > 65536) throw new Error("CONFIGURATION_LIMIT");
                const { windowsNative } = await import("./native/windows.ts");
                windowsNative().replacePrivate(
                    this.directory,
                    "device.json",
                    `.${randomUUID()}.tmp`,
                    value,
                    true,
                );
            } catch (error) {
                if (
                    error instanceof Error &&
                    "win32" in error &&
                    [80, 183].includes(Number(error.win32))
                )
                    throw new Error("ALREADY_ENROLLED");
                throw error;
            } finally {
                await release();
            }
            return;
        }
        const temporary = join(this.directory, `.device-${randomUUID()}.json`);
        try {
            try {
                await lstat(join(this.directory, "device.json"));
                throw new Error("ALREADY_ENROLLED");
            } catch (error) {
                if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
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
        if (this.profile) return this.profile.transaction((tx) => this.renewVault(tx, client));
        await this.prepare();
        const release = await lockfile.lock(this.directory, {
            retries: 0,
            ...(process.platform === "win32"
                ? { lockfilePath: join(this.directory, ".device.lock") }
                : {}),
        });
        const pendingPath = join(this.directory, "rotation.json");
        const atomic = async (path: string, value: unknown) => {
            if (process.platform === "win32") {
                const bytes = JSON.stringify(value);
                if (Buffer.byteLength(bytes) > 65536) throw new Error("CONFIGURATION_LIMIT");
                const { windowsNative } = await import("./native/windows.ts");
                windowsNative().replacePrivate(
                    dirname(path),
                    basename(path),
                    `.${randomUUID()}.tmp`,
                    bytes,
                );
                return;
            }
            const temporary = join(this.directory, `.renew-${randomUUID()}.json`);
            try {
                await writeFile(temporary, JSON.stringify(value), {
                    mode: 0o600,
                    flag: "wx",
                    flush: true,
                });
                await rename(temporary, path);
                const directory = await open(this.directory, "r");
                try {
                    await directory.sync();
                } finally {
                    await directory.close();
                }
            } finally {
                await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
                    if (error.code !== "ENOENT") throw error;
                });
            }
        };
        try {
            const current = await this.load();
            if (current.server !== client.server) throw new Error("DEVICE_PRINCIPAL_CHANGED");
            let pending: {
                previous: DeviceConfig;
                clientRequestId: string;
                replacementToken: string;
            };
            try {
                if (process.platform === "win32") {
                    pending = JSON.parse(
                        (await readBoundedFile(pendingPath, 65536, true)).toString("utf8"),
                    );
                } else {
                    const info = await lstat(pendingPath);
                    if (
                        !info.isFile() ||
                        info.isSymbolicLink() ||
                        info.size > 65536 ||
                        info.mode & 0o077
                    )
                        throw new Error("UNSAFE_ROTATION_JOURNAL");
                    pending = JSON.parse(await readFile(pendingPath, "utf8"));
                }
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
                pending = {
                    previous: current,
                    clientRequestId: randomUUID(),
                    replacementToken: randomBytes(32).toString("base64url"),
                };
                await atomic(pendingPath, pending);
            }
            if (
                pending.previous.server !== current.server ||
                pending.previous.runnerId !== current.runnerId ||
                pending.previous.workspaceId !== current.workspaceId
            )
                throw new Error("DEVICE_PRINCIPAL_CHANGED");
            if (current.deviceToken === pending.replacementToken) {
                await removePrivate(this.directory, "rotation.json");
                return current;
            }
            if (current.deviceToken !== pending.previous.deviceToken)
                throw new Error("DEVICE_CREDENTIAL_CHANGED");
            const receipt = await client.request<Schemas["DeviceCredentialsDTO"]>(
                "/internal/v1/runtime/token/rotate",
                "POST",
                {
                    clientRequestId: pending.clientRequestId,
                    replacementToken: pending.replacementToken,
                },
                current.deviceToken,
            );
            if (
                receipt.runnerId !== current.runnerId ||
                receipt.workspaceId !== current.workspaceId ||
                receipt.deviceToken !== pending.replacementToken
            )
                throw new Error("DEVICE_PRINCIPAL_CHANGED");
            /** 合作锁覆盖轮换事务但不能代替提交前的设备身份核对，另一代设备或令牌变化必须直接拒绝；不能把旧候选覆盖到重新注册的设备上，也不能在提交不确定时重放服务端轮换。 */
            if (JSON.stringify(await this.load()) !== JSON.stringify(current))
                throw new Error("DEVICE_CREDENTIAL_CHANGED");
            const replacement = { ...current, ...receipt };
            await atomic(join(this.directory, "device.json"), replacement);
            await removePrivate(this.directory, "rotation.json");
            return replacement;
        } finally {
            await release();
        }
    }
    /** 加密轮换在同一档案事务锁内读取当前设备与候选，原请求在网络失败后保留而不生成替代秘密；正式设备发布后才退休候选，任何提交不确定性直接上抛，下一次显式恢复按同一请求和当前代际判断。 */
    private async renewVault(
        tx: CredentialTransaction,
        client: RuntimeClient,
    ): Promise<DeviceConfig> {
        const current = await tx.device();
        controlOrigin(current.server);
        const { server: _, ...oldReceipt } = current;
        if (validateSchema("DeviceCredentialsDTO", oldReceipt).length)
            throw new Error("Invalid device configuration");
        if (current.server !== client.server) throw new Error("DEVICE_PRINCIPAL_CHANGED");
        let pending: Rotation | undefined = await tx.rotation();
        if (!pending) {
            pending = {
                previous: current,
                clientRequestId: randomUUID(),
                replacementToken: randomBytes(32).toString("base64url"),
            };
            await tx.saveRotation(pending);
        }
        if (
            pending.previous.server !== current.server ||
            pending.previous.runnerId !== current.runnerId ||
            pending.previous.workspaceId !== current.workspaceId
        )
            throw new Error("DEVICE_PRINCIPAL_CHANGED");
        if (current.deviceToken === pending.replacementToken) {
            await tx.removeDevice(true);
            return current;
        }
        if (current.deviceToken !== pending.previous.deviceToken)
            throw new Error("DEVICE_CREDENTIAL_CHANGED");
        const receipt = await client.request<Schemas["DeviceCredentialsDTO"]>(
            "/internal/v1/runtime/token/rotate",
            "POST",
            {
                clientRequestId: pending.clientRequestId,
                replacementToken: pending.replacementToken,
            },
            current.deviceToken,
        );
        if (
            receipt.runnerId !== current.runnerId ||
            receipt.workspaceId !== current.workspaceId ||
            receipt.deviceToken !== pending.replacementToken
        )
            throw new Error("DEVICE_PRINCIPAL_CHANGED");
        if (JSON.stringify(await tx.device()) !== JSON.stringify(current))
            throw new Error("DEVICE_CREDENTIAL_CHANGED");
        const replacement = { ...current, ...receipt };
        await tx.saveDevice(replacement, false);
        await tx.removeDevice(true);
        return replacement;
    }
    /**
     * 公开方法 ensureStopped 确认本机 Agent 控制通道已停止：避免在旧进程仍存活时覆盖配置（ensureStopped）。
     */
    async ensureStopped() {
        if (
            await lockfile
                .check(join(this.directory, "agent-owner"))
                .catch((error: NodeJS.ErrnoException) => {
                    if (error.code === "ENOENT") return false;
                    throw error;
                })
        )
            throw new Error("AGENT_RUNNING_STOP_FIRST");
    }
    /**
     * 公开方法 hasPendingRotation 检测是否存在未完成的令牌轮换候选：供启动恢复路径决定续写策略（hasPendingRotation）。
     */
    async hasPendingRotation() {
        if (this.profile)
            return this.profile.transaction(async (tx) => (await tx.rotation()) !== undefined);
        if (process.platform === "win32") {
            try {
                await readBoundedFile(join(this.directory, "rotation.json"), 65536, true);
                return true;
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
                throw error;
            }
        }
        try {
            await lstat(join(this.directory, "rotation.json"));
            return true;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
            throw error;
        }
    }
    /**
     * 公开方法 remove 删除本机设备配置：不自动清除离线信任根：显式删档才移除签发者绑定，标注导出符号 remove 供检索。
     */
    async remove() {
        if (this.profile) {
            await this.prepare();
            const owner = join(this.directory, "agent-owner");
            const ownerFiles = await VaultFiles.acquire(owner);
            await ownerFiles.close();
            const release = await lockfile.lock(owner, { retries: 0 }).catch(() => {
                throw new Error("AGENT_RUNNING_STOP_FIRST");
            });
            try {
                await this.profile.transaction((tx) => tx.removeDevice());
            } finally {
                await release();
            }
            return;
        }
        await this.prepare();
        const owner = join(this.directory, "agent-owner");
        if (process.platform === "win32") await privateDirectory(owner);
        else await mkdir(owner, { recursive: true, mode: 0o700 });
        let ownerRelease: () => Promise<void>;
        try {
            ownerRelease = await lockfile.lock(owner, { retries: 0 });
        } catch {
            throw new Error("AGENT_RUNNING_STOP_FIRST");
        }
        try {
            const release = await lockfile.lock(this.directory, {
                retries: 0,
                ...(process.platform === "win32"
                    ? { lockfilePath: join(this.directory, ".device.lock") }
                    : {}),
            });
            try {
                /** 先退休轮换候选再删除正式凭证，使崩溃恢复不会用旧候选复活已注销档案；未知删除失败继续上抛，只有明确不存在可以忽略，档案锁直到两步处理结束才释放。 */
                await removePrivate(this.directory, "rotation.json").catch(
                    (error: NodeJS.ErrnoException) => {
                        if (error.code !== "ENOENT") throw error;
                    },
                );
                await removePrivate(this.directory, "device.json");
            } finally {
                await release();
            }
        } finally {
            await ownerRelease();
        }
    }
}
