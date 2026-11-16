import { createHash, verify } from "node:crypto";
import { constants, createReadStream, createWriteStream } from "node:fs";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { lstat, mkdir, realpath, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readBoundedRegularFile } from "../installation/bounded-file";
import { agentEnvironment } from "./agent-environment";
import type { DesktopRelease } from "../installation/release";

/**
 * 人工更新包把原生安装器的精确摘要、目标、兼容旧版与数据格式放在发布者 Ed25519 签名正文中，回滚同样必须明确声明来源版本；安装器路径只允许同目录单个文件名，页面不能提供任意可执行路径。
 * 签名信任根来自当前安装包资源，未配置时拒绝更新而不从网络自举公钥。
 * profileFormat 必须保持已支持的数据格式，不实施未经迁移设计的数据降级。
 * compatibleEngineVersions 明确保留当前历史所需引擎兼容性，安装后仍需独立检查旧包可执行。
 * 原生签名与发布者清单签名分别校验，Linux 使用发布者签名覆盖整个 deb 字节。
 */
export interface DesktopUpdate {
    schemaVersion: 1;
    appId: "io.github.baofengbaofeng.veriq";
    platform: DesktopRelease["platform"];
    arch: DesktopRelease["arch"];
    version: string;
    direction: "upgrade" | "rollback";
    fromVersions: string[];
    compatibleEngineVersions: string[];
    runtimeEngineVersion: string;
    profileFormat: 2;
    installer: { name: string; sha256: string; sizeBytes: number; nativeSigner: string };
}

/**
 * 原始 base64 正文直接参与标准 Ed25519 验签而不经过可歧义的重新序列化，验签完成后才解释业务字段；未知字段及非法编码一律拒绝，签名有效也不能扩大到其它应用、架构或任意文件扩展名。
 * fromVersions 是显式迁移与回滚授权，不能单凭版本字符串大小就推断兼容。
 * 当前版本重复安装会拒绝，避免把一次检查成功当成可无限重放的升级操作。
 * 所有列表和大小均有固定预算，签名者配置错误也不能让本地消费无界材料。
 */
export function verifyUpdateEnvelope(bytes: Uint8Array, release: DesktopRelease): DesktopUpdate {
    if (!release.updatePublicKeyPem) throw new Error("DESKTOP_UPDATE_KEY_UNCONFIGURED");
    if (bytes.length > 128 * 1024) throw new Error("DESKTOP_UPDATE_MANIFEST_LIMIT");
    const envelope = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (
        !envelope ||
        Object.keys(envelope).sort().join(",") !== "payload,signature" ||
        typeof envelope.payload !== "string" ||
        typeof envelope.signature !== "string" ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.payload) ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.signature)
    )
        throw new Error("DESKTOP_UPDATE_MANIFEST_INVALID");
    /**
     * base64 必须是标准可逆编码且签名恰为 Ed25519 的六十四字节，避免宽松解码容忍多种封套拼写造成审阅与实际验签材料不同；验签采用 payload 原始字节，不经过字段排序或 JSON 规范化转换。
     * 不从封套接收公钥，当前安装的发布者配置才是唯一信任根。
     * 签名失败发生在解析 installer 字段之前，不访问任何待安装路径。
     * JSON 的 UTF8 解码采用 fatal，非法编码不会静默替换为其它文本。
     * 所有错误保持有限分类，签名正文与密钥不进入诊断日志。
     */
    const payload = Buffer.from(envelope.payload, "base64"),
        signature = Buffer.from(envelope.signature, "base64");
    if (
        payload.toString("base64") !== envelope.payload ||
        signature.toString("base64") !== envelope.signature ||
        signature.length !== 64 ||
        !verify(null, payload, release.updatePublicKeyPem, signature)
    )
        throw new Error("DESKTOP_UPDATE_SIGNATURE_INVALID");
    const update = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(payload),
    ) as DesktopUpdate;
    const keys = [
        "schemaVersion",
        "appId",
        "platform",
        "arch",
        "version",
        "direction",
        "fromVersions",
        "compatibleEngineVersions",
        "runtimeEngineVersion",
        "profileFormat",
        "installer",
    ];
    const validVersions = (values: unknown): values is string[] =>
        Array.isArray(values) &&
        values.length > 0 &&
        values.length <= 100 &&
        values.every(
            (value) =>
                typeof value === "string" && /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(value),
        );
    /**
     * 安装载体按当前原生目标固定扩展名，完整文件名只能是同目录可移植单组件；来源版本、数据格式与当前引擎同时构成兼容门槛，回滚方向不会取消这些条件或允许任意数据库降级。
     * 此首版入口只更新桌面壳并保持相同执行引擎。
     * 发布者必须明确列出当前来源版本，而不是由客户端比较版本大小猜测兼容。
     * 安装器大小限制四 GiB，防止误把无关大文件作为本机安装材料。
     * nativeSigner 的有限字符集合允许证书主体或指纹，但禁止命令控制字符。
     * 安装清单允许升级和回滚，当前版本重放仍明确拒绝。
     */
    const extension =
        release.platform === "darwin" ? ".pkg" : release.platform === "win32" ? ".exe" : ".deb";
    if (
        !update ||
        Object.keys(update).length !== keys.length ||
        keys.some((key) => !Object.hasOwn(update, key)) ||
        update.schemaVersion !== 1 ||
        update.appId !== release.appId ||
        update.platform !== release.platform ||
        update.arch !== release.arch ||
        !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(update.version ?? "") ||
        update.version === release.productVersion ||
        !["upgrade", "rollback"].includes(update.direction) ||
        !validVersions(update.fromVersions) ||
        !update.fromVersions.includes(release.productVersion) ||
        !validVersions(update.compatibleEngineVersions) ||
        !update.compatibleEngineVersions.includes(release.trustedRuntime.engineVersion) ||
        update.runtimeEngineVersion !== release.trustedRuntime.engineVersion ||
        update.profileFormat !== release.profileFormat ||
        !update.installer ||
        Object.keys(update.installer).sort().join(",") !== "name,nativeSigner,sha256,sizeBytes" ||
        typeof update.installer.name !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,180}$/.test(update.installer.name) ||
        !update.installer.name.endsWith(extension) ||
        !/^[0-9a-f]{64}$/.test(update.installer.sha256 ?? "") ||
        !Number.isSafeInteger(update.installer.sizeBytes) ||
        update.installer.sizeBytes < 1 ||
        update.installer.sizeBytes > 4 * 1024 * 1024 * 1024 ||
        typeof update.installer.nativeSigner !== "string" ||
        !/^[A-Za-z0-9 ():.@_-]{1,240}$/.test(update.installer.nativeSigner)
    )
        throw new Error("DESKTOP_UPDATE_MANIFEST_INVALID");
    return update;
}

/**
 * 安装器只有复制到本次私有暂存目录并重新计算全文件摘要后才交给系统打开，原始下载目录的链接、硬链接或并发改写不会成为可执行授权；失败只清理本次暂存，不删除用户下载与旧版安装包。
 * Mac 使用 pkgutil 检查安装包签名且匹配清单中明确的安装证书身份。
 * Windows 使用系统 Authenticode 验证有效状态与证书指纹，PowerShell 参数只包含宿主生成路径。
 * Linux 的 Ed25519 清单签名已经认证整个 deb 的字节，不伪称存在 Authenticode。
 * 这些工具只在用户实际发起安装时执行，本轮源码交付不运行签名或系统信任操作。
 */
export async function stageDesktopUpdate(
    manifestPath: string,
    profile: string,
    release: DesktopRelease,
): Promise<{ update: DesktopUpdate; installer: string; cleanup: () => Promise<void> }> {
    const manifest = resolve(manifestPath);
    if ((await realpath(manifest)) !== manifest) throw new Error("DESKTOP_UPDATE_PATH_INVALID");
    const info = await lstat(manifest);
    if (!info.isFile() || info.nlink !== 1 || info.size > 128 * 1024)
        throw new Error("DESKTOP_UPDATE_MANIFEST_INVALID");
    const update = verifyUpdateEnvelope(
        await readBoundedRegularFile(manifest, 128 * 1024),
        release,
    );
    /**
     * 原始安装文件仅定位于签名清单同目录，验证真实普通文件和单硬链接后复制；之后所有系统工具与人工安装入口只接触私有副本，下载目录在复制期间发生变化也必须被副本摘要发现。
     * 不对源文件改权限、不删除用户下载，也不展开未核验归档。
     * 随机 update 目录继承可信 profile 私有边界，Windows 由既有 ACL 保证。
     * 每次只清理自己的随机目录，失败不能顺带退休其它版本的恢复材料。
     * 成功返回 cleanup 能力只由 main 持有，不通过 IPC 交给 renderer。
     */
    const source = join(dirname(manifest), update.installer.name);
    const sourceInfo = await lstat(source);
    if (
        !sourceInfo.isFile() ||
        sourceInfo.isSymbolicLink() ||
        sourceInfo.nlink !== 1 ||
        sourceInfo.size !== update.installer.sizeBytes
    )
        throw new Error("DESKTOP_UPDATE_INSTALLER_INVALID");
    const temporary = join(profile, `update-${randomUUID()}`);
    await mkdir(temporary, { mode: 0o700 });
    const installer = join(temporary, basename(source));
    const cleanup = () => rm(temporary, { recursive: true, force: true });
    try {
        /** 复制也按实际流字节施加签名大小预算，源文件在 lstat 后增长不能无限写满 profile 所在磁盘；输出只允许本次独占新文件，最终摘要仍在关闭复制流后重新计算，不能借流完成代替完整性结论。 */
        let copied = 0;
        await pipeline(
            createReadStream(source, {
                flags: constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
            }),
            new Transform({
                transform(chunk: Buffer, _encoding, callback) {
                    copied += chunk.length;
                    callback(
                        copied > update.installer.sizeBytes
                            ? new Error("DESKTOP_UPDATE_INSTALLER_LIMIT")
                            : null,
                        chunk,
                    );
                },
            }),
            createWriteStream(installer, { flags: "wx", mode: 0o600 }),
        );
        const hash = createHash("sha256");
        for await (const bytes of createReadStream(installer)) hash.update(bytes);
        if (
            (await lstat(installer)).size !== update.installer.sizeBytes ||
            hash.digest("hex") !== update.installer.sha256
        )
            throw new Error("DESKTOP_UPDATE_INSTALLER_HASH_MISMATCH");
        /** 原生签名工具通过固定系统位置与有限会话环境执行，Node/DYLD/PowerShell 模块注入环境不会从桌面进程透传；工具超时或输出不符合预期时仍拒绝，不能降级为仅检查文件摘要。
         * pkgutil 要同时报告系统信任和清单所指 Installer 证书身份。
         * Authenticode 要报告 Valid 并匹配发布者清单中的证书指纹。
         * Linux 不伪造原生签名结论，标准 Ed25519 已覆盖整个 deb 摘要。
         * 原生程序仅执行只读签名检查，这里不安装、获取证书或修改信任库。
         * 用户确认和后台停止检查位于 main 的后续阶段，不由这项静态检查代替。
         */
        if (release.platform === "darwin") {
            const result = await promisify(execFile)(
                "/usr/sbin/pkgutil",
                ["--check-signature", installer],
                {
                    timeout: 30000,
                    maxBuffer: 65536,
                    env: { ...agentEnvironment(""), LANG: "C", LC_ALL: "C" },
                },
            );
            if (
                !result.stdout.includes("Status: signed by a certificate trusted by") ||
                !result.stdout.includes(update.installer.nativeSigner)
            )
                throw new Error("DESKTOP_UPDATE_NATIVE_SIGNATURE_INVALID");
        } else if (release.platform === "win32") {
            const command =
                "$s=Get-AuthenticodeSignature -LiteralPath $env:VERIQ_UPDATE_INSTALLER; @{status=$s.Status.ToString(" +
                ");thumbprint=$s.SignerCertificate.Thumbprint}|ConvertTo-Json -Compress";
            const result = await promisify(execFile)(
                join(
                    process.env.SystemRoot ?? "C:\\Windows",
                    "System32/WindowsPowerShell/v1.0/powershell.exe",
                ),
                ["-NoProfile", "-NonInteractive", "-Command", command],
                {
                    timeout: 30000,
                    maxBuffer: 65536,
                    env: { ...agentEnvironment(""), VERIQ_UPDATE_INSTALLER: installer },
                },
            );
            const signature = JSON.parse(result.stdout);
            if (
                signature.status !== "Valid" ||
                signature.thumbprint !== update.installer.nativeSigner
            )
                throw new Error("DESKTOP_UPDATE_NATIVE_SIGNATURE_INVALID");
        }
        return { update, installer, cleanup };
    } catch (error) {
        await cleanup();
        throw error;
    }
}
