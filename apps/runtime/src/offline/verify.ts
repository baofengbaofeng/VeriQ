/**
 * 本文件在落盘前校验离线包签名与成员哈希：并在执行边界重读已安装树：调用方内存对象不构成权威（verify/INVALID_BUNDLE_SCHEMA）。
 */

/** Verify exact signed bytes before writing any archive member to disk. */
import { createHash, verify } from "node:crypto";
import { readdir, lstat, mkdir, mkdtemp, rename, rm, chmod, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fromBuffer, type Entry, type ZipFile } from "yauzl";
import {
    assetSourceBytes,
    validateSchema,
    type AssetSnapshotV1,
    type BundleManifestV1,
    type FileEntry,
    type PlatformComponents,
} from "@veriq/contracts";
import { readBoundedFile } from "./config.ts";
import { validateContent } from "./content.ts";
import { publicKey, TrustStore } from "./trust.ts";
const MAX_ARCHIVE = 64 * 1024 * 1024,
    MAX_OUTPUT = 128 * 1024 * 1024,
    MAX_FILE = 16 * 1024 * 1024,
    MAX_FILES = 4096;
const digest = (raw: Uint8Array) => createHash("sha256").update(raw).digest("hex");
/**
 * 公开函数 safePath 判定归档成员路径是否可安全落盘：拒绝绝对路径、父目录穿越与 Windows 保留名（safePath/INVALID_BUNDLE_SCHEMA）。
 */
export function safePath(path: string): boolean {
    return (
        path.length <= 240 &&
        path
            .split("/")
            .every(
                (part) =>
                    /^[A-Za-z0-9_@.-]+$/.test(part) &&
                    part !== "." &&
                    part !== ".." &&
                    !/[. ]$/.test(part) &&
                    !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part),
            )
    );
}
function parse<T>(raw: Buffer, schema: string): T {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
    if (validateSchema(schema, value).length) throw new Error("INVALID_BUNDLE_SCHEMA");
    return value as T;
}
async function members(zip: ZipFile): Promise<Map<string, Entry>> {
    return new Promise((resolve, reject) => {
        const entries = new Map<string, Entry>(),
            folded = new Set<string>(),
            paths = new Map<string, { actual: string; directory: boolean }>();
        let size = 0;
        zip.on("error", reject);
        zip.on("entry", (entry: Entry) => {
            const name = entry.fileName,
                mode = entry.externalFileAttributes >>> 16,
                kind = mode & 0o170000;
            size += entry.uncompressedSize;
            let alias = false;
            const parts = name.split("/");
            for (let i = 0; i < parts.length; i++) {
                const actual = parts.slice(0, i + 1).join("/"),
                    lower = actual.toLowerCase(),
                    directory = i < parts.length - 1,
                    prior = paths.get(lower);
                if (prior && (prior.actual !== actual || prior.directory !== directory))
                    alias = true;
                paths.set(lower, { actual, directory });
            }
            if (
                alias ||
                !safePath(name) ||
                folded.has(name.toLowerCase()) ||
                entries.size >= MAX_FILES ||
                entry.isEncrypted() ||
                (kind !== 0 && kind !== 0o100000) ||
                entry.uncompressedSize > MAX_FILE ||
                size > MAX_OUTPUT ||
                ![0, 8].includes(entry.compressionMethod)
            ) {
                reject(new Error("UNSAFE_ARCHIVE"));
                zip.close();
                return;
            }
            entries.set(name, entry);
            folded.add(name.toLowerCase());
            zip.readEntry();
        });
        zip.once("end", () => resolve(entries));
        zip.readEntry();
    });
}
async function bytes(zip: ZipFile, entry: Entry, max: number): Promise<Buffer> {
    if (entry.uncompressedSize > max) throw new Error("BUNDLE_SIZE_LIMIT");
    const stream = await new Promise<import("node:stream").Readable>((resolve, reject) =>
        zip.openReadStream(entry, (err, stream) =>
            err || !stream ? reject(new Error("INVALID_ARCHIVE")) : resolve(stream),
        ),
    );
    const chunks: Buffer[] = [];
    let count = 0;
    for await (const chunk of stream) {
        count += chunk.length;
        if (count > max || count > entry.uncompressedSize) {
            stream.destroy();
            throw new Error("BUNDLE_SIZE_LIMIT");
        }
        chunks.push(chunk);
    }
    if (count !== entry.uncompressedSize) throw new Error("BUNDLE_SIZE_MISMATCH");
    return Buffer.concat(chunks);
}
type S = PlatformComponents["schemas"];
/**
 * 公开类型 VerifiedBundle 表示签名与哈希均已通过的离线包：含清单、快照与可安装成员字节（VerifiedBundle/UNSAFE_ARCHIVE）。
 */
export type VerifiedBundle = {
    manifest: BundleManifestV1;
    snapshot: AssetSnapshotV1;
    directory: string;
    revocationStatus: "UNKNOWN";
    debug: boolean;
    formalGateEligible: false;
    resourceSnapshot: () => {
        workspaceId: string;
        resources: S["ResourceDTO"][];
        versions: S["ResourceVersionDTO"][];
        drafts?: S["DraftDTO"][];
        sourceFiles: Record<string, S["CompiledSourceDTO"]>;
        readSource: (versionId: string, file: FileEntry, signal?: AbortSignal) => Promise<string>;
    };
};
/**
 * 公开函数 verifyBundle 在写入任何成员前验证签名字节与清单哈希：失败时清理临时树：通过后才允许安装（verifyBundle/UNSAFE_ARCHIVE）。
 */
export async function verifyBundle(
    input: string,
    options: {
        trust: TrustStore;
        destination: string;
        debug?: boolean;
        workspaceId?: string;
    },
): Promise<VerifiedBundle> {
    const st = await lstat(input);
    if (!st.isFile() || st.isSymbolicLink() || st.size > MAX_ARCHIVE)
        throw new Error("UNSAFE_ARCHIVE");
    const raw = await readBoundedFile(input, MAX_ARCHIVE);
    if (raw.length > MAX_ARCHIVE) throw new Error("BUNDLE_SIZE_LIMIT");
    const zip = await new Promise<ZipFile>((resolve, reject) =>
        fromBuffer(
            raw,
            {
                lazyEntries: true,
                autoClose: false,
                validateEntrySizes: true,
                strictFileNames: true,
            },
            (error, file) =>
                error || !file ? reject(new Error("INVALID_ARCHIVE")) : resolve(file),
        ),
    );
    let staging: string | undefined;
    try {
        const entries = await members(zip),
            manifestEntry = entries.get("manifest.json"),
            sigEntry = entries.get("manifest.sig");
        if (!manifestEntry || !sigEntry) throw new Error("BUNDLE_MANIFEST_MISSING");
        const manifestRaw = await bytes(zip, manifestEntry, 1024 * 1024),
            sig = await bytes(zip, sigEntry, 64);
        const manifest = parse<BundleManifestV1>(manifestRaw, "BundleManifestV1");
        const issuer = await options.trust.issuer(manifest.issuerId),
            key = issuer.keys.find((k) => k.keyId === manifest.keyId);
        if (!key) throw new Error("ISSUER_KEY_NOT_TRUSTED");
        if (key.revoked) throw new Error("ISSUER_KEY_REVOKED");
        if (sig.length !== 64 || !verify(null, manifestRaw, publicKey(key), sig))
            throw new Error("BUNDLE_SIGNATURE_INVALID");
        if (options.workspaceId && manifest.workspaceId !== options.workspaceId)
            throw new Error("BUNDLE_WORKSPACE_MISMATCH");
        const expired = Date.parse(manifest.expiresAt) <= Date.now();
        if (Date.parse(manifest.expiresAt) <= Date.parse(manifest.createdAt))
            throw new Error("INVALID_BUNDLE_DATES");
        const debug = expired || manifest.validationStatus !== "VALIDATED";
        if (debug && !options.debug)
            throw new Error(expired ? "BUNDLE_EXPIRED" : "BUNDLE_DEBUG_REQUIRED");
        const expected = new Set<string>(["manifest.json", "manifest.sig"]);
        const contents = new Map<string, Buffer>();
        let expanded = manifestRaw.length + sig.length;
        for (const file of manifest.files) {
            if (!safePath(file.path) || expected.has(file.path) || file.sizeBytes > MAX_FILE)
                throw new Error("INVALID_BUNDLE_FILES");
            expected.add(file.path);
            const entry = entries.get(file.path);
            if (!entry || entry.uncompressedSize !== file.sizeBytes)
                throw new Error("BUNDLE_FILE_MISSING");
            const content = await bytes(zip, entry, Math.min(file.sizeBytes, MAX_FILE));
            expanded += content.length;
            if (expanded > MAX_OUTPUT) throw new Error("BUNDLE_SIZE_LIMIT");
            if (digest(content) !== file.sha256) throw new Error("BUNDLE_HASH_MISMATCH");
            contents.set(file.path, content);
        }
        if (expected.size !== entries.size) throw new Error("BUNDLE_EXTRA_FILE");
        const snapshotRaw = contents.get("snapshot.json");
        if (!snapshotRaw || digest(snapshotRaw) !== manifest.snapshotSha256)
            throw new Error("BUNDLE_SNAPSHOT_MISMATCH");
        const snapshot = parse<AssetSnapshotV1>(snapshotRaw, "AssetSnapshotV1");
        if (
            snapshot.workspaceId !== manifest.workspaceId ||
            snapshot.engineVersion !== manifest.engineVersion ||
            snapshot.sourceHash !== manifest.sourceHash ||
            digest(assetSourceBytes(snapshot as unknown as Record<string, unknown>)) !==
                manifest.sourceHash
        )
            throw new Error("BUNDLE_SNAPSHOT_MISMATCH");
        const { resources, dslOnly } = validateContent(contents, manifest, snapshot);
        await mkdir(dirname(options.destination), { recursive: true, mode: 0o700 });
        const parent = await lstat(dirname(options.destination));
        if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error("UNSAFE_DESTINATION");
        staging = await mkdtemp(join(dirname(options.destination), ".veriq-bundle-"));
        for (const [name, body] of new Map([
            ["manifest.json", manifestRaw],
            ["manifest.sig", sig],
            ...contents,
        ])) {
            const path = join(staging, name);
            await mkdir(dirname(path), { recursive: true, mode: 0o700 });
            await writeFile(path, body, { flag: "wx", mode: 0o400 });
        }
        // Never overwrite an existing verified installation (including nonempty/symlink targets).
        try {
            await lstat(options.destination);
            throw new Error("BUNDLE_DESTINATION_EXISTS");
        } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
                throw error;
        }
        const directories = new Set<string>([staging]);
        for (const name of contents.keys()) {
            let parent = dirname(join(staging, name));
            while (parent !== staging) {
                directories.add(parent);
                parent = dirname(parent);
            }
        }
        for (const directory of [...directories].sort((a, b) => b.length - a.length))
            await chmod(directory, 0o500);
        await rename(staging, options.destination);
        staging = undefined;
        return {
            manifest: structuredClone(manifest),
            snapshot: structuredClone(snapshot),
            directory: options.destination,
            revocationStatus: "UNKNOWN",
            debug,
            formalGateEligible: false,
            resourceSnapshot: () => {
                const sourceFiles: Record<string, S["CompiledSourceDTO"]> = {};
                for (const version of resources.versions) {
                    if (dslOnly) continue;
                    const descriptorRaw = contents.get(`provenance/${version.id}/descriptor.json`);
                    if (!descriptorRaw) throw new Error("BUNDLE_PROVENANCE_MISSING");
                    const descriptor = parse<import("@veriq/contracts").CompiledAssetBundle>(
                        descriptorRaw,
                        "CompiledAssetBundle",
                    );
                    sourceFiles[version.id] = {
                        descriptorSha256: digest(descriptorRaw),
                        files: descriptor.files.filter((f) =>
                            /^(validation\.ts|source\/context\.ts|cases\/[0-9a-f-]{36}\.test\.ts)$/i.test(
                                f.path,
                            ),
                        ),
                    };
                }
                const drafts: S["DraftDTO"][] = [];
                if (dslOnly) {
                    const target = snapshot.validationTarget!,
                        asset = snapshot.assets.find((a) => a.versionId === target.versionId)!;
                    const frozen = JSON.parse(
                        contents.get("draft/metadata.json")!.toString("utf8"),
                    ) as { frozenAt: string };
                    drafts.push({
                        resourceId: asset.resourceId,
                        revision: target.revision,
                        content: {
                            kind: asset.kind,
                            document: asset.document,
                        } as S["ResourceDocumentV1"],
                        updatedAt: frozen.frozenAt,
                        documentHash: asset.sha256,
                    });
                }
                return {
                    workspaceId: manifest.workspaceId,
                    ...structuredClone(resources),
                    drafts,
                    sourceFiles,
                    readSource: async (versionId, file, signal) => {
                        signal?.throwIfAborted();
                        const member = sourceFiles[versionId]?.files.find(
                            (f) =>
                                f.path === file.path &&
                                f.sha256 === file.sha256 &&
                                f.sizeBytes === file.sizeBytes,
                        );
                        if (!member) throw new Error("SOURCE_NOT_AVAILABLE");
                        const body = contents.get(`compiled/${versionId}/${file.path}`);
                        if (!body || digest(body) !== file.sha256 || body.length !== file.sizeBytes)
                            throw new Error("BUNDLE_HASH_MISMATCH");
                        return body.toString("utf8");
                    },
                };
            },
        };
    } finally {
        zip.close();
        if (staging) {
            async function writable(directory: string): Promise<void> {
                await chmod(directory, 0o700);
                for (const entry of await readdir(directory, { withFileTypes: true }))
                    if (entry.isDirectory()) await writable(join(directory, entry.name));
            }
            await writable(staging);
            await rm(staging, { recursive: true, force: true });
        }
    }
}

/**
 * Re-read an installed tree at the execution boundary; caller objects confer no authority.
 */
/**
 * 公开函数 reverifyInstalled 在执行边界重读已安装目录并复核哈希：调用方持有的对象副本不具备权威（reverifyInstalled/UNSAFE_BUNDLE_DIRECTORY）。
 */
export async function reverifyInstalled(
    directory: string,
    options: {
        trust: TrustStore;
        debug?: boolean;
        workspaceId?: string;
    },
) {
    const root = await lstat(directory);
    if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("UNSAFE_BUNDLE_DIRECTORY");
    const manifestRaw = await readBoundedFile(join(directory, "manifest.json"), 1024 * 1024);
    const signature = await readBoundedFile(join(directory, "manifest.sig"), 64);
    const manifest = parse<BundleManifestV1>(manifestRaw, "BundleManifestV1");
    const issuer = await options.trust.issuer(manifest.issuerId);
    const key = issuer.keys.find((key) => key.keyId === manifest.keyId);
    if (!key) throw new Error("ISSUER_KEY_NOT_TRUSTED");
    if (key.revoked) throw new Error("ISSUER_KEY_REVOKED");
    if (signature.length !== 64 || !verify(null, manifestRaw, publicKey(key), signature))
        throw new Error("BUNDLE_SIGNATURE_INVALID");
    if (options.workspaceId && manifest.workspaceId !== options.workspaceId)
        throw new Error("BUNDLE_WORKSPACE_MISMATCH");
    if (Date.parse(manifest.expiresAt) <= Date.parse(manifest.createdAt))
        throw new Error("INVALID_BUNDLE_DATES");
    const expired = Date.parse(manifest.expiresAt) <= Date.now(),
        debug = expired || manifest.validationStatus !== "VALIDATED";
    if (debug && !options.debug)
        throw new Error(expired ? "BUNDLE_EXPIRED" : "BUNDLE_DEBUG_REQUIRED");
    const actual = new Set<string>();
    async function walk(relative: string): Promise<void> {
        for (const entry of await readdir(join(directory, relative), { withFileTypes: true })) {
            const path = relative ? `${relative}/${entry.name}` : entry.name;
            if (!safePath(path) || entry.isSymbolicLink())
                throw new Error("UNSAFE_BUNDLE_DIRECTORY");
            if (entry.isDirectory()) await walk(path);
            else if (entry.isFile()) actual.add(path);
            else throw new Error("UNSAFE_BUNDLE_DIRECTORY");
            if (actual.size > MAX_FILES) throw new Error("BUNDLE_SIZE_LIMIT");
        }
    }
    await walk("");
    const expected = new Set(["manifest.json", "manifest.sig"]),
        contents = new Map<string, Buffer>();
    let size = manifestRaw.length + signature.length;
    for (const file of manifest.files) {
        if (!safePath(file.path) || expected.has(file.path) || file.sizeBytes > MAX_FILE)
            throw new Error("INVALID_BUNDLE_FILES");
        expected.add(file.path);
        if (!actual.has(file.path)) throw new Error("BUNDLE_FILE_MISSING");
        const raw = await readBoundedFile(join(directory, file.path), MAX_FILE);
        if (raw.length !== file.sizeBytes) throw new Error("BUNDLE_SIZE_MISMATCH");
        if (digest(raw) !== file.sha256) throw new Error("BUNDLE_HASH_MISMATCH");
        size += raw.length;
        if (size > MAX_OUTPUT) throw new Error("BUNDLE_SIZE_LIMIT");
        contents.set(file.path, raw);
    }
    if (actual.size !== expected.size) throw new Error("BUNDLE_EXTRA_FILE");
    const raw = contents.get("snapshot.json");
    if (!raw || digest(raw) !== manifest.snapshotSha256)
        throw new Error("BUNDLE_SNAPSHOT_MISMATCH");
    const snapshot = parse<AssetSnapshotV1>(raw, "AssetSnapshotV1");
    if (
        snapshot.workspaceId !== manifest.workspaceId ||
        snapshot.engineVersion !== manifest.engineVersion ||
        snapshot.sourceHash !== manifest.sourceHash ||
        digest(assetSourceBytes(snapshot as unknown as Record<string, unknown>)) !==
            manifest.sourceHash
    )
        throw new Error("BUNDLE_SNAPSHOT_MISMATCH");
    const validated = validateContent(contents, manifest, snapshot);
    return { manifest, manifestRaw, snapshot, contents, debug, expired, ...validated };
}
