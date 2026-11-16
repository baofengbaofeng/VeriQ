import { createPrivateKey, sign } from "node:crypto";
import { lstat, writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { readBoundedRegularFile } from "../src/installation/bounded-file.ts";
import { parseDesktopRelease } from "../src/installation/release.ts";
import { verifyUpdateEnvelope } from "../src/main/update.ts";

/**
 * 发布者必须显式提供已经保管的 Ed25519 私钥与经过审核的更新正文，本命令只产生标准签名封套而不申请密钥、证书或发布权限；正文仍通过当前发行公钥和全部目标兼容约束，不能签出 GUI 自己不会接受的更新策略。私钥从独立绝对路径读取，
 * 不通过 argv、日志或生成物回显任何密钥内容。POSIX 私钥必须属于当前用户并禁止组和其它用户访问，链接与多硬链接均拒绝。Windows 私钥访问依赖原生发布账户 ACL，正式密钥操作前仍须独立完成该环境审查。输出只允许新文件，
 * 重签或修订必须另选路径，已有发布材料不会被隐式覆盖。此命令不执行原生代码签名，installer 的 Authenticode/pkg 签名由既有平台工具独立完成。
 */
async function main(): Promise<void> {
    const flags = new Map<string, string>();
    const names = ["--release", "--payload", "--key-file", "--output"];
    for (let index = 2; index < process.argv.length; index += 2) {
        const key = process.argv[index]!, value = process.argv[index + 1];
        if (!names.includes(key) || flags.has(key) || !value || !isAbsolute(value)) throw new Error("DESKTOP_UPDATE_SIGN_ARGUMENT_INVALID");
        flags.set(key, value);
    }
    if (flags.size !== names.length) throw new Error("DESKTOP_UPDATE_SIGN_ARGUMENT_MISSING");
    async function input(path: string, limit: number): Promise<Buffer> {
        return readBoundedRegularFile(path, limit);
    }
    const release = parseDesktopRelease(JSON.parse((await input(flags.get("--release")!, 1024 * 1024)).toString("utf8")));
    const keyPath = flags.get("--key-file")!;
    const keyInfo = await lstat(keyPath);
    if (process.platform !== "win32" && (keyInfo.uid !== process.getuid!() || (keyInfo.mode & 0o077) !== 0))
        throw new Error("DESKTOP_UPDATE_SIGN_KEY_NOT_PRIVATE");
    const key = createPrivateKey(await input(keyPath, 16384));
    if (key.asymmetricKeyType !== "ed25519") throw new Error("DESKTOP_UPDATE_SIGN_KEY_INVALID");
    const payload = await input(flags.get("--payload")!, 65536);
    const envelope = Buffer.from(JSON.stringify({ payload: payload.toString("base64"), signature: sign(null, payload, key).toString("base64") }) + "\n");
    verifyUpdateEnvelope(envelope, release);
    await writeFile(flags.get("--output")!, envelope, { flag: "wx", mode: 0o644 });
    process.stdout.write("VeriQ update manifest signed; native acceptance and publication remain separate gates.\n");
}
main().catch((error: unknown) => {
    process.stderr.write(`VeriQ update manifest signing failed: ${error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : "DESKTOP_UPDATE_SIGN_FAILED"}\n`);
    process.exitCode = 1;
});
