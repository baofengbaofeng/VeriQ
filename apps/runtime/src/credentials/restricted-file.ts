/** 受管理无桌面 Linux 服务可以明确选择私有文件密钥模式，但该模式不提供静态加密保护，也不能由桌面或保险库失败自动启用；后端只在核验指定服务 UID、真实持久挂载及私有目录后操作本产品有限密钥成员，不赋予控制平台信任。 */
import { open, lstat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { observeRestrictedOperation, type RestrictedFileResult } from "./restricted-operation.ts";
import { VaultFiles } from "./files.ts";
import type {
    VaultKeyBackend,
    VaultKeyScope,
    VaultBackendFailure,
    VaultMutationResult,
} from "./backend.ts";
import type { CredentialOptions } from "./profile.ts";

/** 文件模式策略由可信服务启动入口明确构造，必须独立确认专用运行用户和不提供静态加密的性质；卷与档案只能是绝对数据路径，不能指定可执行程序，系统管理员仍需负责该账户专用性和外置卷的实际持久运维。 */
export type ManagedFilePolicy = {
    mode: "restricted-file";
    managedHeadless: boolean;
    serviceUid: number;
    persistentVolume: string;
    profileDirectory: string;
    acknowledgeUnencryptedStorage: boolean;
};
type Mount = { id: string; device: string; root: string; type: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function fail(code: string): never {
    throw new Error(`RESTRICTED_FILE_${code}`);
}
function context(policy: ManagedFilePolicy) {
    if (process.platform !== "linux") throw new Error("VAULT_PLATFORM_UNSUPPORTED");
    if (
        !policy ||
        policy.mode !== "restricted-file" ||
        policy.managedHeadless !== true ||
        policy.acknowledgeUnencryptedStorage !== true ||
        !Number.isSafeInteger(policy.serviceUid) ||
        policy.serviceUid <= 0 ||
        process.getuid!() !== policy.serviceUid ||
        process.geteuid!() !== policy.serviceUid ||
        process.getgid!() !== process.getegid!() ||
        process.versions.electron ||
        process.env.DISPLAY ||
        process.env.WAYLAND_DISPLAY ||
        typeof policy.persistentVolume !== "string" ||
        !isAbsolute(policy.persistentVolume) ||
        typeof policy.profileDirectory !== "string" ||
        !isAbsolute(policy.profileDirectory) ||
        policy.persistentVolume.includes("\0") ||
        policy.profileDirectory.includes("\0")
    )
        fail("CONTEXT_REQUIRED");
    const volume = resolve(policy.persistentVolume),
        profile = resolve(policy.profileDirectory),
        child = relative(volume, profile);
    if (volume !== policy.persistentVolume || profile !== policy.profileDirectory)
        fail("CONTEXT_REQUIRED");
    if (volume === "/" || child === ".." || child.startsWith("../") || isAbsolute(child))
        fail("PERSISTENT_VOLUME_REQUIRED");
}
function unescapeMount(value: string): string {
    if (/\\(?!040|011|012|134)/.test(value)) fail("PERSISTENT_VOLUME_REQUIRED");
    return value.replace(/\\(040|011|012|134)/g, (_all, octal: string) =>
        String.fromCharCode(parseInt(octal, 8)),
    );
}
/** 挂载观察只读取当前命名空间的固定 proc 文件，按一兆字节上限完成而不相信伪文件的零长度 stat；选定卷必须恰为一个可写非内存挂载点，普通目录、容器可写层、重复遮蔽和根卷均不能冒充独立持久卷。 */
async function mountedVolume(volume: string): Promise<Mount> {
    const handle = await open("/proc/self/mountinfo", "r");
    const bytes = Buffer.alloc(1024 * 1024 + 1);
    let used = 0;
    try {
        while (used < bytes.length) {
            const result = await handle.read(bytes, used, bytes.length - used, null);
            if (!result.bytesRead) break;
            used += result.bytesRead;
        }
    } finally {
        await handle.close();
    }
    if (used > 1024 * 1024) fail("PERSISTENT_VOLUME_REQUIRED");
    const matches: Mount[] = [];
    for (const line of new TextDecoder("utf-8", { fatal: true })
        .decode(bytes.subarray(0, used))
        .trim()
        .split("\n")) {
        const fields = line.split(" "),
            separator = fields.indexOf("-");
        if (fields.length < 10 || separator < 6 || !fields[separator + 1])
            fail("PERSISTENT_VOLUME_REQUIRED");
        if (unescapeMount(fields[4]!) !== volume) continue;
        const type = fields[separator + 1]!;
        if (
            !fields[5]!.split(",").includes("rw") ||
            ["tmpfs", "ramfs", "overlay", "proc", "sysfs", "devtmpfs", "squashfs"].includes(type)
        )
            fail("PERSISTENT_VOLUME_REQUIRED");
        matches.push({ id: fields[0]!, device: fields[2]!, root: fields[3]!, type });
    }
    if (matches.length !== 1) fail("PERSISTENT_VOLUME_REQUIRED");
    return matches[0]!;
}
async function verify(policy: ManagedFilePolicy, expected?: Mount): Promise<Mount> {
    context(policy);
    const mount = await mountedVolume(resolve(policy.persistentVolume));
    if (expected && JSON.stringify(mount) !== JSON.stringify(expected))
        fail("PERSISTENT_VOLUME_CHANGED");
    const volume = await lstat(policy.persistentVolume);
    if (
        !volume.isDirectory() ||
        volume.isSymbolicLink() ||
        volume.uid !== policy.serviceUid ||
        (volume.mode & 0o777) !== 0o700
    )
        fail("DIRECTORY_NOT_PRIVATE");
    const files = await VaultFiles.acquire(policy.persistentVolume);
    await files.close();
    return mount;
}
function name(scope: VaultKeyScope): string {
    if (
        !scope ||
        Object.keys(scope).sort().join() !== "keyVersion,profileId" ||
        typeof scope.profileId !== "string" ||
        typeof scope.keyVersion !== "string" ||
        !UUID.test(scope.profileId) ||
        !UUID.test(scope.keyVersion)
    )
        fail("SCOPE_INVALID");
    return `raw-key-${scope.profileId}-${scope.keyVersion}.json`;
}
function key(wire: string, scope: VaultKeyScope): Buffer {
    const value = JSON.parse(wire);
    if (
        !value ||
        Object.keys(value).sort().join() !== "key,keyVersion,profileId,version" ||
        value.version !== 1 ||
        value.profileId !== scope.profileId ||
        value.keyVersion !== scope.keyVersion ||
        typeof value.key !== "string" ||
        !/^[A-Za-z0-9_-]{43}$/.test(value.key)
    )
        fail("KEY_INVALID");
    const result = Buffer.from(value.key, "base64url");
    if (result.length !== 32 || result.toString("base64url") !== value.key) {
        result.fill(0);
        fail("KEY_INVALID");
    }
    return result;
}
/** 文件后端不会获得 OS vault 身份，原始随机密钥保存在同卷受限目录，因此密文载荷只复用现有完整性与事务格式；每次操作重查真实挂载与用户，读写删除均持密钥目录合作锁，不能覆盖已有确切版本或把提交不确定映射成成功。 */
class RestrictedFileBackend implements VaultKeyBackend {
    private readonly directory: string;
    constructor(
        private policy: ManagedFilePolicy,
        private mount: Mount,
    ) {
        this.directory = join(policy.profileDirectory, "restricted-keys");
    }
    private operation(
        signal: AbortSignal,
        run: (files: VaultFiles, markMutation: () => void) => Promise<RestrictedFileResult>,
    ): Promise<RestrictedFileResult> {
        return observeRestrictedOperation(
            this.directory,
            signal,
            async (observed, markMutation) => {
                let files: VaultFiles | undefined, release: (() => Promise<void>) | undefined;
                let result: RestrictedFileResult | undefined;
                try {
                    await verify(this.policy, this.mount);
                    if (observed.aborted) throw new Error("RESTRICTED_FILE_OBSERVATION_ABORTED");
                    const existing = await lstat(this.directory);
                    if (!existing.isDirectory() || existing.isSymbolicLink())
                        fail("DIRECTORY_NOT_PRIVATE");
                    files = await VaultFiles.acquire(this.directory);
                    release = await lockfile.lock(this.directory, { realpath: false, retries: 0 });
                    if (observed.aborted) throw new Error("RESTRICTED_FILE_OBSERVATION_ABORTED");
                    result = await run(files, markMutation);
                    return result;
                } finally {
                    try {
                        try {
                            await files?.close();
                        } finally {
                            await release?.();
                        }
                    } catch (error) {
                        if (result && "key" in result) result.key.fill(0);
                        throw error;
                    }
                }
            },
        );
    }
    /** 读取仅解码指定档案与版本的原始三十二字节密钥并交付独立缓冲区，畸形内容和权限错误保持失败；本模式的原始密钥可以由合法文件拥有者读取，因此任何调用方都不能把它描述成系统保险库或加密静态存储。 */
    async get(
        scope: VaultKeyScope,
        signal: AbortSignal,
    ): Promise<{ status: "ok"; key: Buffer } | VaultBackendFailure> {
        let member: string;
        try {
            member = name(scope);
        } catch {
            return { status: "failed" };
        }
        return (await this.operation(signal, async (files) => {
            const wire = await files.read(member);
            return wire === undefined
                ? { status: "missing" as const }
                : { status: "ok" as const, key: key(wire, scope) };
        })) as { status: "ok"; key: Buffer } | VaultBackendFailure;
    }
    /** 写入只接受新的精确版本与固定长度密钥，合作锁内发现既存成员就拒绝而不覆盖；原子文件发布复用现有刷新及未知提交处理，取消后仍报告可能已提交，不能通过再次生成随机密钥掩盖第一次写入状态。 */
    async set(
        scope: VaultKeyScope,
        material: Buffer,
        signal: AbortSignal,
    ): Promise<VaultMutationResult> {
        let member: string;
        try {
            member = name(scope);
        } catch {
            return { status: "failed" };
        }
        if (!Buffer.isBuffer(material) || material.length !== 32) return { status: "failed" };
        const wire = JSON.stringify({
            version: 1,
            profileId: scope.profileId,
            keyVersion: scope.keyVersion,
            key: material.toString("base64url"),
        });
        return this.operation(signal, async (files, markMutation) => {
            if ((await files.read(member)) !== undefined) return { status: "failed" as const };
            markMutation();
            await files.write(member, wire);
            return { status: "ok" as const };
        }) as Promise<VaultMutationResult>;
    }
    /** 删除只核验指定成员的完整范围与私有文件格式，未找到才报告 missing；调用方的凭据退休日志仍负责原密钥摘要和删除后的实际缺失确认，单独本接口不会枚举其他档案、擦除整个目录或撤销控制平台设备。 */
    async delete(scope: VaultKeyScope, signal: AbortSignal): Promise<VaultMutationResult> {
        let member: string;
        try {
            member = name(scope);
        } catch {
            return { status: "failed" };
        }
        return this.operation(signal, async (files, markMutation) => {
            const wire = await files.read(member);
            if (wire === undefined) return { status: "missing" as const };
            key(wire, scope).fill(0);
            markMutation();
            await files.remove(member);
            return { status: "ok" as const };
        }) as Promise<VaultMutationResult>;
    }
    /** 探测只证明当前时刻的用户、挂载身份和私有目录可访问，不声称外部卷在机器销毁后必然保留；服务部署者需要另外配置持久生命周期，后端不会因探测失败搜索系统保险库或选择另一个可写目录继续运行。 */
    async probe(signal: AbortSignal): Promise<{ status: "ready" } | VaultBackendFailure> {
        return (await this.operation(signal, async () => ({ status: "ready" as const }))) as
            | { status: "ready" }
            | VaultBackendFailure;
    }
}
/** 只有显式受管理无桌面 Linux 启动可以构造此凭据上下文，所有事实检查成功后才创建档案和密钥目录；函数不注册设备或授予 MANAGED 信任，也不能被桌面保险库故障路径调用作为自动降级，固定模式声明必须由调用者展示。 */
export async function managedFileCredentials(input: ManagedFilePolicy): Promise<CredentialOptions> {
    const policy = Object.freeze({ ...input });
    context(policy);
    let mount: Mount | undefined, failure: Error | undefined;
    const result = await observeRestrictedOperation(
        join(policy.profileDirectory, "restricted-keys"),
        new AbortController().signal,
        async (signal, markMutation) => {
            try {
                mount = await verify(policy);
                for (const directory of [
                    policy.profileDirectory,
                    join(policy.profileDirectory, "restricted-keys"),
                ]) {
                    if (signal.aborted) throw new Error("RESTRICTED_FILE_OBSERVATION_ABORTED");
                    markMutation();
                    const files = await VaultFiles.acquire(directory);
                    await files.close();
                }
                return { status: "ready" };
            } catch (error) {
                if (error instanceof Error && /^RESTRICTED_FILE_[A-Z_]+$/.test(error.message))
                    failure = error;
                throw error;
            }
        },
    );
    if (result.status !== "ready" || !mount)
        throw (
            failure ??
            new Error(
                result.status === "mutation-unconfirmed"
                    ? "RESTRICTED_FILE_CONTEXT_UNCONFIRMED"
                    : "RESTRICTED_FILE_CONTEXT_FAILED",
            )
        );
    return { backend: new RestrictedFileBackend(policy, mount) };
}
