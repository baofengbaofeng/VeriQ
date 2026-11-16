import { create } from "tar";
import { mkdtemp, lstat, open } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
    verifyMacRuntimeManifestV2,
    type MacChromeLayout,
    type MacRuntimeArch,
} from "../src/distribution-manifest-v2.ts";
import {
    admitReleaseRoot,
    copyReleaseFile,
    inventoryReleaseTree,
    writeReleaseJson,
} from "./runtime-release-files.ts";

/**
 * 归档描述保留本次实际 tar.gz 的大小与摘要及完整 Runtime manifest 身份，签名和独立批准仍由后续发行者完成；调用者不能把
 * 候选 archive 的校验和文件当作可信 Expected 或正式发布签名。
 * receipt 原字节作为独立 sidecar 一起交付，压缩归档只包含安装 Runtime 根，不将源码、构建工具或私有缓存带进安装包。
 */
export type RuntimeArchiveResult = Readonly<{
    kind: "RUNTIME_CANDIDATE_ARCHIVE";
    directory: string;
    archive: { path: string; sizeBytes: number; sha256: string };
    runtimeManifestSha256: string;
    status: "UNVERIFIED";
}>;

/**
 * 完整发行归档只消费静态库存允许的成员，Mac 使用独立链接布局先后两次真实复验，其他平台则复用无链接完整普通树枚举；tar
 * 不追随链接且不递归已列目录，避免 Framework 别名重复展开或打包额外文件。压缩时间和属主元数据固定，
 * 结束后再核原树库存与 manifest 原始摘要，观察到任何变化都保留失败输出而不交付成功描述。新输出目录由本轮独占创建，已有
 * 候选和历史归档永不覆盖，任何异常都保留供独立验证任务诊断。
 */
export async function packageRuntimeCandidate(
    options: Readonly<{
        runtimeDirectory: string;
        receiptPath: string;
        outputParent: string;
        candidateName: string;
        mac?: { arch: MacRuntimeArch; layout: MacChromeLayout };
    }>,
): Promise<RuntimeArchiveResult> {
    const metadata = structuredClone(options);
    await admitReleaseRoot(metadata.runtimeDirectory);
    await admitReleaseRoot(metadata.outputParent);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(metadata.candidateName))
        throw new Error("RUNTIME_ARCHIVE_NAME_INVALID");
    const observe = async () => {
        if (metadata.mac) {
            const report = await verifyMacRuntimeManifestV2(
                metadata.runtimeDirectory,
                metadata.mac,
            );
            return {
                manifestSha256: report.manifestSha256,
                identity: JSON.stringify(report.manifest),
                paths: [
                    "runtime-manifest.json",
                    ...report.manifest.directories,
                    ...report.manifest.files.map((file) => file.path),
                    ...report.manifest.links.map((link) => link.path),
                ].sort(),
            };
        }
        const inventory = await inventoryReleaseTree(metadata.runtimeDirectory, "entries");
        const manifest = inventory.files.find((file) => file.path === "runtime-manifest.json");
        if (!manifest) throw new Error("RUNTIME_MANIFEST_MISSING");
        return {
            manifestSha256: manifest.sha256,
            identity: JSON.stringify(inventory),
            paths: [...inventory.directories, ...inventory.files.map((file) => file.path)].sort(),
        };
    };
    const before = await observe();
    const directory = await mkdtemp(
        join(metadata.outputParent, `.veriq-archive-${metadata.candidateName}-`),
    );
    const archivePath = `${metadata.candidateName}.tar.gz`;
    await create(
        {
            cwd: metadata.runtimeDirectory,
            file: join(directory, archivePath),
            gzip: true,
            portable: true,
            mtime: new Date(0),
            noPax: true,
            noDirRecurse: true,
            follow: false,
        },
        before.paths,
    );
    const after = await observe();
    if (before.identity !== after.identity || before.manifestSha256 !== after.manifestSha256)
        throw new Error("RUNTIME_ARCHIVE_SOURCE_CHANGED");
    const file = join(directory, archivePath);
    const info = await lstat(file, { bigint: true });
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const digest = createHash("sha256"),
        buffer = Buffer.alloc(65536);
    let sizeBytes = 0;
    try {
        while (true) {
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, sizeBytes);
            if (!bytesRead) break;
            sizeBytes += bytesRead;
            digest.update(buffer.subarray(0, bytesRead));
        }
        const settled = await handle.stat({ bigint: true });
        if (
            sizeBytes !== Number(info.size) ||
            info.ino !== settled.ino ||
            info.dev !== settled.dev ||
            info.mtimeNs !== settled.mtimeNs ||
            info.ctimeNs !== settled.ctimeNs
        )
            throw new Error("RUNTIME_ARCHIVE_CHANGED");
    } finally {
        await handle.close();
    }
    const archive = { path: archivePath, sizeBytes, sha256: digest.digest("hex") };
    const receipt = await copyReleaseFile(
        metadata.receiptPath,
        directory,
        "payload-receipt.json",
        undefined,
        0o644,
    );
    const result: RuntimeArchiveResult = {
        kind: "RUNTIME_CANDIDATE_ARCHIVE",
        directory,
        archive,
        runtimeManifestSha256: before.manifestSha256,
        status: "UNVERIFIED",
    };
    const candidate = await writeReleaseJson(directory, "candidate.json", result);
    await writeReleaseJson(directory, "checksums.json", {
        schemaVersion: 1,
        files: [
            archive,
            { path: receipt.path, sizeBytes: receipt.sizeBytes, sha256: receipt.sha256 },
            candidate,
        ],
        excludedSelf: "checksums.json",
    });
    return result;
}
