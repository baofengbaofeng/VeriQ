import { constants, open, close, fstat } from "node:fs";
import { crc32 } from "node:zlib";
import { finished } from "node:stream/promises";
import { fromFdPromise, type Entry, type ZipFile } from "yauzl";
import type { Readable } from "node:stream";
import { RuntimePayloadError } from "./runtime-payload-inputs.ts";
import {
    attachArchiveRejection,
    setArchiveRejectionContext,
    type ArchiveScan,
    type ArchiveRejectionFacts,
} from "./runtime-payload-archive.ts";

/** ZIP 范围检查只消费公开的 local header offset、dataStart 与 central compressedSize，保证文件边界和各 local/data 区间互斥；不读取私有 cursor 或自造 EOCD、ZIP64 与 descriptor 解释器，因此不会声称验证公开 API 无法证明的全域语法。 */
export class ZipRanges {
    private readonly ranges: { start: number; end: number }[] = [];
    /** 区间以安全整数逐项准入，二分位置同时检查左右相邻区间即可证明整体不重叠；重复 local header 和越界都在打开正文流之前拒绝，最多四万个条目保持有界，未压缩长度不被拿来代替实际 data 范围。 */
    add(start: number, dataStart: number, end: number, fileSize: number) {
        if (
            ![start, dataStart, end, fileSize].every(Number.isSafeInteger) ||
            start < 0 ||
            start >= dataStart ||
            dataStart > end ||
            end > fileSize ||
            this.ranges.length >= 40000
        )
            throw new RuntimePayloadError("PAYLOAD_ARCHIVE_RANGE");
        let low = 0,
            high = this.ranges.length;
        while (low < high) {
            const mid = (low + high) >>> 1;
            if (this.ranges[mid]!.start < start) low = mid + 1;
            else high = mid;
        }
        if (
            (low && this.ranges[low - 1]!.end > start) ||
            (low < this.ranges.length && this.ranges[low]!.start < end)
        )
            throw new RuntimePayloadError("PAYLOAD_ARCHIVE_RANGE");
        this.ranges.splice(low, 0, { start, end });
    }
}
/** lazy ZIP 每次只读一个 central entry，等待其完整解压流关闭后才允许 readEntry；原始文件名与 local flags、method 必须逐字一致，Node crc32 对普通文件、空目录及逻辑链接均按实际解压块累计并核对最终长度。 */
export async function scanZip(path: string, scan: ArchiveScan, fileSize: number) {
    let fd: number | undefined = await new Promise<number>((resolve, reject) =>
        open(
            path,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
            (error, value) => (error ? reject(error) : resolve(value)),
        ),
    );
    let zip: ZipFile | undefined,
        stream: Readable | undefined,
        zipFailure: unknown,
        closed: Promise<unknown> | undefined;
    const ranges = new ZipRanges();
    let metadata = 0,
        count = 0;
    const abort = () => {
        stream?.destroy(new RuntimePayloadError("PAYLOAD_CANCELLED"));
        zip?.close();
    };
    try {
        const size = await new Promise<number>((resolve, reject) =>
            fstat(fd!, (error, value) => (error ? reject(error) : resolve(value.size))),
        );
        if (size !== fileSize) scan.tx.fail("PAYLOAD_SOURCE_CHANGED");
        zip = await fromFdPromise(fd, {
            autoClose: false,
            lazyEntries: true,
            strictFileNames: true,
            validateEntrySizes: true,
        });
        fd = undefined;
        zip.on("error", (error: unknown) => {
            zipFailure ??= error;
        });
        closed = new Promise<void>((resolve) => zip!.once("close", resolve));
        scan.tx.signal?.addEventListener("abort", abort, { once: true });
        while (true) {
            scan.tx.check();
            const entry = await next(zip);
            if (!entry) break;
            if (++count > 40000) scan.tx.fail("PAYLOAD_LIMIT");
            const local = await zip.readLocalFileHeaderPromise(entry, { minimal: false });
            scan.tx.check();
            metadata +=
                entry.fileNameLength +
                entry.extraFieldLength +
                entry.fileCommentLength +
                local.fileNameLength +
                local.extraFieldLength;
            if (
                entry.fileNameLength + entry.extraFieldLength + entry.fileCommentLength >
                    64 * 1024 ||
                local.fileNameLength + local.extraFieldLength > 64 * 1024 ||
                metadata > 4 * 1024 ** 2
            )
                scan.tx.fail("PAYLOAD_LIMIT");
            ranges.add(
                entry.relativeOffsetOfLocalHeader,
                local.fileDataStart,
                local.fileDataStart + entry.compressedSize,
                fileSize,
            );
            if (
                !local.fileName.equals(entry.fileNameRaw) ||
                local.generalPurposeBitFlag !== entry.generalPurposeBitFlag ||
                local.compressionMethod !== entry.compressionMethod ||
                entry.fileNameRaw.toString("ascii") !== entry.fileName ||
                entry.fileNameRaw.some((v) => v > 127)
            )
                scan.tx.fail("PAYLOAD_ARCHIVE_RANGE");
            const context: Omit<ArchiveRejectionFacts, "reason"> = {
                archive: scan.kind,
                stage: "ZIP_ENTRY",
                headerIndex: count,
                memberIndex: count,
                path: entry.fileNameRaw,
                size: entry.uncompressedSize,
                rawMode: entry.externalFileAttributes >>> 16,
                type: (entry.externalFileAttributes >>> 16) & 0o170000,
                details: {
                    versionMadeBy: entry.versionMadeBy,
                    host: entry.versionMadeBy >>> 8,
                    externalFileAttributes: entry.externalFileAttributes >>> 0,
                    method: entry.compressionMethod,
                    flags: entry.generalPurposeBitFlag,
                    directorySuffix: entry.fileName.endsWith("/"),
                    localMethod: local.compressionMethod,
                    localFlags: local.generalPurposeBitFlag,
                    compressedSize: entry.compressedSize,
                    localCompressedSize: local.compressedSize,
                    localUncompressedSize: local.uncompressedSize,
                },
            };
            const unsupported = (
                reason: ArchiveRejectionFacts["reason"],
                details: ArchiveRejectionFacts["details"],
            ): never => {
                try {
                    scan.tx.fail("PAYLOAD_ARCHIVE_UNSUPPORTED");
                } catch (error) {
                    attachArchiveRejection(error, {
                        ...context,
                        reason,
                        details: { ...context.details, ...details },
                    });
                    throw error;
                }
            };
            /** Stored 的 0x6 位没有本方法定义的解码含义，固定资产与成熟解码器的逐字节校验支持保留原值作为元数据；仍核对原始 local/central flags，诊断 storedFlags 只记录位存在而不单独拒绝。 */
            if (![0, 8].includes(entry.compressionMethod) || entry.generalPurposeBitFlag & ~0x80e)
                unsupported("ZIP_METHOD_FLAGS", {
                    methodUnsupported: ![0, 8].includes(entry.compressionMethod),
                    flagsUnsupported: !!(entry.generalPurposeBitFlag & ~0x80e),
                    storedFlags:
                        entry.compressionMethod === 0 && !!(entry.generalPurposeBitFlag & 6),
                });
            if (
                !(entry.generalPurposeBitFlag & 8) &&
                ((local.compressedSize !== 0xffffffff &&
                    local.compressedSize !== entry.compressedSize) ||
                    (local.uncompressedSize !== 0xffffffff &&
                        local.uncompressedSize !== entry.uncompressedSize) ||
                    local.crc32 !== entry.crc32)
            )
                scan.tx.fail("PAYLOAD_ARCHIVE_RANGE");
            const host = entry.versionMadeBy >>> 8,
                rawMode = entry.externalFileAttributes >>> 16,
                type = rawMode & 0o170000,
                directory = entry.fileName.endsWith("/");
            if (
                (host !== 3 && host !== 0) ||
                (host === 3 && ![0, 0o100000, 0o040000, 0o120000].includes(type))
            )
                unsupported("ZIP_HOST_TYPE", {
                    hostUnsupported: host !== 3 && host !== 0,
                    typeUnsupported:
                        host === 3 && ![0, 0o100000, 0o040000, 0o120000].includes(type),
                });
            if (
                (host === 0 && rawMode) ||
                (directory && type && type !== 0o040000) ||
                (!directory && type === 0o040000) ||
                (entry.externalFileAttributes & 0x10 && !directory)
            )
                unsupported("ZIP_DIRECTORY_MODE", {
                    dosMode: host === 0 && !!rawMode,
                    directoryType: directory && !!type && type !== 0o040000,
                    fileType: !directory && type === 0o040000,
                    dosDirectory: !!(entry.externalFileAttributes & 0x10) && !directory,
                });
            const kind = type === 0o120000 ? "link" : directory ? "directory" : "file";
            const mode =
                host === 3 && rawMode ? rawMode & 0o7777 : kind === "directory" ? 0o755 : 0o644;
            setArchiveRejectionContext(scan, context);
            stream = await zip.openReadStreamPromise(entry);
            scan.tx.check();
            const completion = finished(stream);
            completion.catch(() => {});
            let size = 0,
                crc = 0;
            const content = async function* (source: Readable) {
                for await (const data of source) {
                    scan.tx.check();
                    const chunk = Buffer.from(data);
                    size += chunk.length;
                    if (size > entry.uncompressedSize) scan.tx.fail("PAYLOAD_LIMIT");
                    crc = crc32(chunk, crc);
                    yield chunk;
                }
                if (size !== entry.uncompressedSize) scan.tx.fail("PAYLOAD_ARCHIVE_FORMAT");
                if (crc >>> 0 !== entry.crc32 >>> 0) scan.tx.fail("PAYLOAD_ARCHIVE_CRC");
            };
            try {
                await scan.entry(
                    { path: entry.fileName, kind, mode, size: entry.uncompressedSize },
                    content(stream),
                );
                await completion;
            } finally {
                stream.destroy();
                await completion.catch(() => {});
                stream = undefined;
            }
            if (zipFailure) throw zipFailure;
        }
        if (zipFailure) throw zipFailure;
        await scan.finish();
    } catch (error) {
        if (error instanceof RuntimePayloadError) throw error;
        if (scan.tx.signal?.aborted) scan.tx.fail("PAYLOAD_CANCELLED");
        scan.tx.fail("PAYLOAD_ARCHIVE_FORMAT");
    } finally {
        scan.tx.signal?.removeEventListener("abort", abort);
        if (stream) {
            stream.destroy();
            await finished(stream).catch(() => {});
        }
        if (zip) {
            if (zip.isOpen) zip.close();
            await closed;
        } else if (fd !== undefined)
            await new Promise<void>((resolve, reject) =>
                close(fd!, (error) => (error ? reject(error) : resolve())),
            );
    }
}
/** 每次 central 准入都同时监听结束、错误和当前 entry，并在任何结果后移除另外两个监听；不预读下一成员或访问库私有游标，异步关闭和取消由同一拥有者负责，不遗留会被下一次请求误消费的事件处理器。 */
function next(zip: ZipFile): Promise<Entry | null> {
    return new Promise((resolve, reject) => {
        const cleanup = () => {
            zip.removeListener("entry", entry);
            zip.removeListener("end", end);
            zip.removeListener("error", error);
            zip.removeListener("close", closed);
        };
        const entry = (value: Entry) => {
            cleanup();
            resolve(value);
        };
        const end = () => {
            cleanup();
            resolve(null);
        };
        const error = (value: unknown) => {
            cleanup();
            reject(value);
        };
        const closed = () => {
            cleanup();
            reject(new RuntimePayloadError("PAYLOAD_CANCELLED"));
        };
        zip.once("entry", entry);
        zip.once("end", end);
        zip.once("error", error);
        zip.once("close", closed);
        zip.readEntry();
    });
}
