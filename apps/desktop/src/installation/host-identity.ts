import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join, resolve } from "node:path";
import { realpath } from "node:fs/promises";
import { agentEnvironment } from "../main/agent-environment";
import type { DesktopRelease } from "./release";

/** 宿主身份能力只在同一模块的真实 Mac 布局与签名检查后签发，公开对象没有可用于反序列化的授权字段；Cookie 门闩必须再次查
 * 私有集合，普通布尔标记、克隆对象或合成单元输入均不能授权真实持久会话。
 */
export type DesktopHostIdentity = Readonly<{ platform: "darwin" }>;
const identities = new WeakSet<object>();

/** Cookie 门闩只接受本进程实际验证过的原始身份对象，不能凭接口形状或平台字符串绕过安装身份检查；此能力不包含凭据、原生
 * 文件接口、进程停止证明或对 Keychain 的额外操作授权。
 */
export function requireMacDesktopIdentity(identity: unknown): void {
    if (!identity || typeof identity !== "object" || !identities.has(identity))
        throw new Error("COOKIE_MAC_HOST_IDENTITY_REQUIRED");
}

/** Mac 入口在任何私有文件或原生插件装载前验证真实应用布局、最低系统与固定 Bundle ID，签名模式决定是否还必须取得原生签名
 * 验证；unsigned 明确保留开发身份，不能因恰有同名应用就被当作签名发行。
 * 发布者身份由外部期望写入安装资源，签名验证不能从当前待核应用自报 Authority 反推批准值。ad-hoc 只要求有效本机代码签名
 * 而不宣称正式发布者，生产模式则精确匹配 Developer ID Authority。
 * 所有命令为固定系统工具与参数数组，不把 renderer、环境或清单字段拼成 shell。Windows 与 Linux 的实际发行签名验收仍在独
 * 立目标门禁登记，不通过 Mac 检查冒称其它平台已验收。
 */
export async function verifyDesktopHost(
    release: DesktopRelease,
    resources: string,
): Promise<DesktopHostIdentity | undefined> {
    if (release.platform !== process.platform || release.arch !== process.arch)
        throw new Error("DESKTOP_RELEASE_TARGET_MISMATCH");
    if (release.platform !== "darwin") return;
    const contents = dirname(resolve(resources));
    const application = dirname(contents);
    if (
        !application.endsWith("/veriq.app") ||
        (await realpath(application)) !== application ||
        resolve(process.execPath) !== join(contents, "MacOS/veriq")
    )
        throw new Error("DESKTOP_APPLICATION_IDENTITY_INVALID");
    const execute = promisify(execFile);
    const options = { timeout: 10000, maxBuffer: 65536, env: agentEnvironment("") };
    const version = await execute("/usr/bin/sw_vers", ["-productVersion"], options);
    if (
        !/^\d+\.\d+(?:\.\d+)?$/.test(version.stdout.trim()) ||
        Number(version.stdout.trim().split(".")[0]) < 15
    )
        throw new Error("DESKTOP_MACOS15_REQUIRED");
    const identifier = await execute(
        "/usr/libexec/PlistBuddy",
        ["-c", "Print :CFBundleIdentifier", join(contents, "Info.plist")],
        options,
    );
    if (identifier.stdout.trim() !== release.appId)
        throw new Error("DESKTOP_APPLICATION_IDENTITY_INVALID");
    const identity = (): DesktopHostIdentity => {
        const value = Object.freeze({ platform: "darwin" as const });
        identities.add(value);
        return value;
    };
    if (release.signing.mode === "DEVELOPMENT_UNSIGNED") return identity();
    await execute("/usr/bin/codesign", ["--verify", "--deep", "--strict", application], options);
    const signature = await execute(
        "/usr/bin/codesign",
        ["--display", "--verbose=4", application],
        options,
    );
    const lines = signature.stderr.split(/\r?\n/);
    if (!lines.includes(`Identifier=${release.appId}`))
        throw new Error("DESKTOP_SIGNATURE_IDENTITY_INVALID");
    if (
        release.signing.mode === "NATIVE_SIGNED" &&
        (!release.signing.identity || !lines.includes(`Authority=${release.signing.identity}`))
    )
        throw new Error("DESKTOP_SIGNATURE_IDENTITY_INVALID");
    return identity();
}
