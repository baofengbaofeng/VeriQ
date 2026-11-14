/** Cookie 验收仅修改本次工作区新建的独立 Electron 副本，绝不原位修改 pnpm 硬链接或下载缓存；成熟 fuse 工具逐字节读回后记录原始与修改后的身份，目标策略与测试随后必须使用这个固定副本，不能把源包默认值当作产品保护。 */
import { cp, lstat, mkdir, readFile, realpath, statfs, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { flipFuses, getCurrentFuseWire, FuseVersion, FuseV1Options } from "@electron/fuses";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
const evidence = process.env.VERIQ_DESKTOP_EVIDENCE ?? process.env.VERIQ_NATIVE_EVIDENCE;
if (!["linux", "win32"].includes(process.platform) || !evidence || !process.env.GITHUB_ENV)
    throw new Error("COOKIE_CI_CONTEXT_REQUIRED");
const packageRoot = dirname(require.resolve("electron/package.json"));
if (JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")).version !== "45.3.1")
    throw new Error("COOKIE_ELECTRON_VERSION_INVALID");
const source = await realpath(join(packageRoot, "dist"));
const destination = resolve(root, "build/electron-cookie");
try {
    await lstat(destination);
    throw new Error("COOKIE_COPY_ALREADY_EXISTS");
} catch (error) {
    if (error.code !== "ENOENT") throw error;
}
const disk = await statfs(root, { bigint: true });
if (disk.bavail * disk.bsize < 2147483648n) throw new Error("COOKIE_COPY_DISK_RESERVE_REQUIRED");
/** 官方归档使用已锁 Electron 包附带的校验和与成熟下载器核验，缓存命中也需读回真实摘要；固定官方 URL 不继承镜像重定向配置，只有目标 CI 会执行此处，记录实际载荷大小而非把压缩估计当作磁盘预算。 */
const electronRequire = createRequire(join(packageRoot, "package.json"));
const { downloadArtifact } = electronRequire("@electron/get");
const archiveName = `electron-v45.3.1-${process.platform}-x64.zip`;
const officialUrl = `https://github.com/electron/electron/releases/download/v45.3.1/${archiveName}`;
const checksums = JSON.parse(await readFile(join(packageRoot, "checksums.json"), "utf8"));
if (process.arch !== "x64" || !/^[a-f0-9]{64}$/.test(checksums[archiveName] ?? ""))
    throw new Error("COOKIE_ARCHIVE_IDENTITY_REQUIRED");
const archive = await downloadArtifact({
    version: "45.3.1",
    platform: process.platform,
    arch: "x64",
    artifactName: "electron",
    checksums,
    cacheRoot: process.env.electron_config_cache,
    mirrorOptions: { resolveAssetURL: async () => officialUrl },
});
await mkdir(dirname(destination), { recursive: true });
await cp(source, destination, {
    recursive: true,
    force: false,
    errorOnExist: true,
    verbatimSymlinks: true,
});
const filename = process.platform === "win32" ? "electron.exe" : "electron";
const original = join(source, filename);
const executable = join(destination, filename);
const [oldInfo, newInfo] = await Promise.all([lstat(original), lstat(executable)]);
if (
    !oldInfo.isFile() ||
    !newInfo.isFile() ||
    newInfo.nlink !== 1 ||
    (oldInfo.dev === newInfo.dev && oldInfo.ino === newInfo.ino)
)
    throw new Error("COOKIE_ELECTRON_COPY_NOT_INDEPENDENT");
const hash = async (path) => {
    const digest = createHash("sha256");
    for await (const chunk of createReadStream(path)) digest.update(chunk);
    return digest.digest("hex");
};
const originalSha256 = await hash(original);
const archiveSha256 = await hash(archive);
if (archiveSha256 !== checksums[archiveName]) throw new Error("COOKIE_ARCHIVE_HASH_MISMATCH");
if ((await hash(executable)) !== originalSha256) throw new Error("COOKIE_COPY_CHANGED_BYTES");
const before = await getCurrentFuseWire(executable);
await flipFuses(executable, {
    version: FuseVersion.V1,
    [FuseV1Options.EnableCookieEncryption]: true,
});
const after = await getCurrentFuseWire(executable);
if (after.version !== FuseVersion.V1 || after[FuseV1Options.EnableCookieEncryption] !== 49)
    throw new Error("COOKIE_FUSE_READBACK_FAILED");
for (const key of Object.keys(before))
    if (key !== String(FuseV1Options.EnableCookieEncryption) && before[key] !== after[key])
        throw new Error("COOKIE_UNRELATED_FUSE_CHANGED");
if ((await hash(original)) !== originalSha256) throw new Error("COOKIE_SOURCE_PACKAGE_CHANGED");
await writeFile(
    join(evidence, "cookie-fuses.json"),
    JSON.stringify(
        {
            packageVersion: "45.3.1",
            toolVersion: "1.8.0",
            original,
            executable,
            originalSha256,
            modifiedSha256: await hash(executable),
            before,
            after,
            independentCopy: true,
            sourceUnchanged: true,
            officialUrl,
            archiveSha256,
            archiveBytes: (await lstat(archive)).size,
            executableBytes: oldInfo.size,
            initialAvailableBytes: String(disk.bavail * disk.bsize),
            requiredReserveBytes: "2147483648",
        },
        null,
        4,
    ) + "\n",
);
await writeFile(process.env.GITHUB_ENV, `VERIQ_TEST_ELECTRON=${executable}\n`, { flag: "a" });
console.log("Cookie encryption fuse configured on independent Electron copy");
