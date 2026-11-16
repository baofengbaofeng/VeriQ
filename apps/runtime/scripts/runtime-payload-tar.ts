import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { createGunzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { once } from "node:events";
import { Header, Pax, Parser, type ReadEntry } from "tar";
import { RuntimePayloadError } from "./runtime-payload-inputs.ts";
import { limits } from "./runtime-payload-tree.ts";
import {
    attachArchiveRejection,
    setArchiveRejectionContext,
    type ArchiveScan,
    type ArchiveRejectionFacts,
} from "./runtime-payload-archive.ts";

/**
 * tar framing guard 只用成熟公开 Header 解释数字和校验和，把真实流分成有界 header、正文及 padding；它同时要求双零终止和
 * 有限零尾，不能因为 Parser 提前看到 EOF 就忽略后续 gz
 * ip trailer 损坏或非零垃圾。
 */
class TarFrames {
    bytes = 0;
    private pending = Buffer.alloc(0);
    private body = 0;
    private padding = 0;
    private zeros = 0;
    private tail = 0;
    private metaBytes = 0;
    private metaCount = 0;
    private meta: { header: Buffer; body: Buffer[]; type: string; size: number } | undefined;
    private afterMeta = false;
    private index = 0;
    private context: Omit<ArchiveRejectionFacts, "reason"> | undefined;
    /**
     * 每个 framing 拒绝都复用刚读到的成熟 Header 上下文，只在原本要抛错的位置附加诊断；捕获内部失败由弱表入口吸收，仍抛
     * 原先相同分类的异常，不继续解析或等待后续成员。
     */
    private unsupported(
        reason: ArchiveRejectionFacts["reason"],
        details: ArchiveRejectionFacts["details"] = {},
        metadata?: Buffer,
        unknownKey?: string,
    ): never {
        const error = new RuntimePayloadError("PAYLOAD_ARCHIVE_UNSUPPORTED");
        try {
            if (this.context)
                attachArchiveRejection(error, {
                    ...this.context,
                    stage: metadata ? "TAR_METADATA" : "TAR_FRAME",
                    reason,
                    metadata,
                    details: {
                        ...this.context.details,
                        ...details,
                        unknownKeySha256:
                            unknownKey === undefined
                                ? null
                                : createHash("sha256").update(unknownKey).digest("hex"),
                    },
                });
        } catch {
            // 这里的可选上下文合并与未知键摘要同样属于诊断而非归档准入，捕获或分配失败时仍必须抛下方原异常；不能让辅助
            // 事实构造遮蔽真实成员类型、元数据或权限拒绝。
        }
        throw error;
    }
    /**
     * 每个输入块只保留不足一个 header 或最多六十四 KiB 元数据，普通正文直接流过不累计；guard 在普通帧结束处向协调器报告
     * 边界，让下一成员必须等待当前正文、摘要及私有输出句柄全部完成后才进入成熟 Parser
     * 。
     */
    *feed(input: Buffer, scan: ArchiveScan): Generator<{ bytes: Buffer; boundary: boolean }> {
        this.bytes += input.length;
        if (this.bytes > limits.total + 64 * 1024 ** 2)
            throw new RuntimePayloadError("PAYLOAD_LIMIT");
        let rest: Buffer = this.pending.length ? Buffer.concat([this.pending, input]) : input;
        this.pending = Buffer.alloc(0);
        while (rest.length) {
            if (this.zeros >= 2) {
                this.tail += rest.length;
                if (this.tail > 1024 ** 2) throw new RuntimePayloadError("PAYLOAD_LIMIT");
                if (rest.some((v) => v !== 0))
                    throw new RuntimePayloadError("PAYLOAD_ARCHIVE_FORMAT");
                yield { bytes: rest, boundary: false };
                return;
            }
            if (this.body) {
                const n = Math.min(this.body, rest.length),
                    part = rest.subarray(0, n);
                rest = rest.subarray(n);
                this.body -= n;
                if (this.meta) this.meta.body.push(Buffer.from(part));
                else yield { bytes: part, boundary: !this.body && !this.padding };
                if (this.body) continue;
                if (!this.padding && this.meta) {
                    yield this.metadata();
                }
                continue;
            }
            if (this.padding) {
                const n = Math.min(this.padding, rest.length),
                    part = rest.subarray(0, n);
                rest = rest.subarray(n);
                this.padding -= n;
                if (part.some((v) => v !== 0))
                    throw new RuntimePayloadError("PAYLOAD_ARCHIVE_FORMAT");
                if (!this.meta) yield { bytes: part, boundary: !this.padding };
                else if (!this.padding) yield this.metadata();
                continue;
            }
            if (rest.length < 512) {
                this.pending = Buffer.from(rest);
                return;
            }
            const raw = rest.subarray(0, 512);
            rest = rest.subarray(512);
            const header = new Header(raw);
            this.index++;
            if (header.nullBlock) {
                if (this.afterMeta) throw new RuntimePayloadError("PAYLOAD_ARCHIVE_FORMAT");
                this.zeros++;
                yield { bytes: raw, boundary: false };
                continue;
            }
            if (this.zeros || !header.cksumValid)
                throw new RuntimePayloadError("PAYLOAD_ARCHIVE_FORMAT");
            const size = header.size ?? 0,
                type = header.type;
            if (!Number.isSafeInteger(size) || size < 0)
                throw new RuntimePayloadError("PAYLOAD_ARCHIVE_FORMAT");
            const metadata = [
                "ExtendedHeader",
                "GlobalExtendedHeader",
                "NextFileHasLongPath",
                "NextFileHasLongLinkpath",
            ].includes(type);
            this.context = {
                archive: scan.kind,
                stage: "TAR_FRAME",
                headerIndex: this.index,
                memberIndex: null,
                path: header.path,
                size,
                rawMode: header.mode,
                type,
                header: raw,
                details: { checksumValid: header.cksumValid },
            };
            if (metadata) {
                if (
                    size > 64 * 1024 ||
                    this.metaBytes + size > 4 * 1024 ** 2 ||
                    ++this.metaCount > 40000
                )
                    throw new RuntimePayloadError("PAYLOAD_LIMIT");
                if (!size) this.unsupported("TAR_META_EMPTY");
                this.metaBytes += size;
                this.meta = { header: Buffer.from(raw), body: [], type, size };
                this.afterMeta = true;
            } else {
                if (!["File", "OldFile", "Directory", "SymbolicLink"].includes(type))
                    this.unsupported("TAR_ENTRY_TYPE");
                if (size > limits.file) throw new RuntimePayloadError("PAYLOAD_LIMIT");
                if ((type === "Directory" || type === "SymbolicLink") && size !== 0)
                    throw new RuntimePayloadError("PAYLOAD_ARCHIVE_FORMAT");
                if (header.mode === undefined || header.mode < 0 || header.mode > 0o777)
                    this.unsupported("TAR_HEADER_MODE", {
                        modeMissing: header.mode === undefined,
                        modeNegative: (header.mode ?? 0) < 0,
                        modeHigh: (header.mode ?? 0) > 0o777,
                    });
                setArchiveRejectionContext(scan, this.context);
                this.afterMeta = false;
                yield { bytes: raw, boundary: !size };
            }
            this.body = size;
            this.padding = (512 - (size % 512)) % 512;
        }
    }
    /**
     * PAX 支持限于明确单行 ASCII 字段，raw 检查只识别 key 与记录存在性而不解码长度或数值；每条都交公开 Pax.parse 且必须
     * 保留有效事实，再经 encodeField 与 parse 往返核解释一致
     * ，静默丢弃或未知扩展不会被忽略。
     */
    private metadata() {
        const meta = this.meta!,
            body = Buffer.concat(meta.body, meta.size);
        if (meta.type === "ExtendedHeader" || meta.type === "GlobalExtendedHeader") {
            const text = body.toString("utf8"),
                seen = new Set<string>();
            if (!text.endsWith("\n") || /[^\x20-\x7e\n]/.test(text))
                this.unsupported(
                    "TAR_PAX_TEXT",
                    { missingNewline: !text.endsWith("\n"), nonAscii: /[^\x20-\x7e\n]/.test(text) },
                    body,
                );
            let recordIndex = 0;
            for (const record of text.slice(0, -1).split("\n")) {
                recordIndex++;
                const match =
                    /^[0-9]+ (path|linkpath|mtime|atime|ctime|uid|gid|uname|gname)=([\x20-\x7e]*)$/.exec(
                        record,
                    );
                if (!match || seen.has(match[1]!))
                    this.unsupported(
                        "TAR_PAX_RECORD",
                        {
                            recordIndex,
                            malformedOrUnknown: !match,
                            duplicate: !!match && seen.has(match[1]!),
                            approvedKey: match?.[1] ?? null,
                        },
                        body,
                        !match &&
                            record.indexOf(" ") >= 0 &&
                            record.indexOf("=") > record.indexOf(" ")
                            ? record.slice(record.indexOf(" ") + 1, record.indexOf("="))
                            : undefined,
                    );
                const key = match[1] as
                    | "path"
                    | "linkpath"
                    | "mtime"
                    | "atime"
                    | "ctime"
                    | "uid"
                    | "gid"
                    | "uname"
                    | "gname";
                seen.add(key);
                const parsed = Pax.parse(record + "\n"),
                    value = parsed[key];
                if (
                    value === undefined ||
                    (value instanceof Date && !Number.isFinite(value.getTime())) ||
                    (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0)) ||
                    (typeof value === "string" && !value.length)
                )
                    this.unsupported(
                        "TAR_PAX_VALUE",
                        {
                            recordIndex,
                            approvedKey: key,
                            missing: value === undefined,
                            invalidDate: value instanceof Date && !Number.isFinite(value.getTime()),
                            invalidNumber:
                                typeof value === "number" &&
                                (!Number.isSafeInteger(value) || value < 0),
                            emptyString: typeof value === "string" && !value.length,
                            valueKind: value instanceof Date ? "DATE" : typeof value,
                        },
                        body,
                    );
                const roundtrip = Pax.parse(parsed.encodeField(key))[key];
                if (
                    value instanceof Date
                        ? !(roundtrip instanceof Date) || value.getTime() !== roundtrip.getTime()
                        : value !== roundtrip
                )
                    this.unsupported(
                        "TAR_PAX_ROUNDTRIP",
                        {
                            recordIndex,
                            approvedKey: key,
                            valueKind: value instanceof Date ? "DATE" : typeof value,
                            roundtripKind: roundtrip instanceof Date ? "DATE" : typeof roundtrip,
                            dateMismatch:
                                value instanceof Date &&
                                (!(roundtrip instanceof Date) ||
                                    value.getTime() !== roundtrip.getTime()),
                            valueMismatch: !(value instanceof Date) && value !== roundtrip,
                        },
                        body,
                    );
            }
        } else {
            const target = body.toString("utf8").replace(/\0+$/, "");
            if (!target || /[^\x20-\x7e]/.test(target) || Buffer.byteLength(target) > 1024)
                this.unsupported(
                    "TAR_GNU_TEXT",
                    {
                        empty: !target,
                        nonAscii: /[^\x20-\x7e]/.test(target),
                        tooLong: Buffer.byteLength(target) > 1024,
                    },
                    body,
                );
        }
        this.meta = undefined;
        return {
            bytes: Buffer.concat([
                meta.header,
                body,
                Buffer.alloc((512 - (meta.size % 512)) % 512),
            ]),
            boundary: false,
        };
    }
    /**
     * 完整解压流结束时必须正好处于帧边界并且看到两个终止零块，不能用 gzip 成功替代 tar 完整性；残余 header、正文或
     * padding 都是截断，尾部元数据没有实际成员消费也不能得到成功回执。
     */
    finish() {
        if (
            this.pending.length ||
            this.body ||
            this.padding ||
            this.meta ||
            this.zeros < 2 ||
            this.afterMeta
        )
            throw new RuntimePayloadError("PAYLOAD_ARCHIVE_FORMAT");
    }
}

/**
 * 有界 tar 适配器从当前私有快照 held FD 完整消费 gzip，并用公开 Parser 应用已验证元数据后才交公共路径表；逐帧背压与成员
 * 任务串行保证只有当前正文在读取，所有失败会中止流、Parser 和当前 ReadE
 * ntry 并等待它们结束。
 */
export async function scanTar(path: string, scan: ArchiveScan): Promise<number> {
    const handle = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const source = handle.createReadStream({
        autoClose: false,
        highWaterMark: 64 * 1024,
        signal: scan.tx.signal,
    });
    const gunzip = createGunzip(),
        parser = new Parser({ strict: true, maxMetaEntrySize: 64 * 1024 });
    const framing = new TarFrames();
    let parserTail = Buffer.alloc(0);
    let rejected = false;
    let failure: unknown,
        current: ReadEntry | undefined,
        work: Promise<void> = Promise.resolve();
    parser.on("error", (error: unknown) => {
        failure ??= error;
        gunzip.destroy(error instanceof Error ? error : new Error("TAR_INVALID"));
    });
    parser.on("entry", (entry: ReadEntry) => {
        current = entry;
        entry.on("error", (error: unknown) => {
            failure ??= error;
        });
        const kind =
            entry.type === "Directory"
                ? "directory"
                : entry.type === "SymbolicLink"
                  ? "link"
                  : "file";
        work = scan
            .entry(
                {
                    path: entry.path,
                    kind,
                    mode: entry.mode ?? -1,
                    size: entry.size,
                    ...(kind === "link" ? { target: entry.linkpath ?? "" } : {}),
                },
                entry,
            )
            .catch((error: unknown) => {
                failure ??= error;
                entry.destroy(error instanceof Error ? error : new Error("TAR_INVALID"));
                parser.abort(new Error("TAR_ABORTED"));
                gunzip.destroy(error instanceof Error ? error : new Error("TAR_INVALID"));
            });
    });
    const aborted = () => {
        const error = new RuntimePayloadError("PAYLOAD_CANCELLED");
        failure ??= error;
        current?.destroy(error);
        parser.abort(new Error("TAR_ABORTED"));
        source.destroy(error);
        gunzip.destroy(error);
    };
    scan.tx.signal?.addEventListener("abort", aborted, { once: true });
    const pumping = pipeline(source, gunzip).catch((error: unknown) => {
        failure ??= error;
        gunzip.destroy(error instanceof Error ? error : new Error("GZIP_INVALID"));
    });
    try {
        for await (const value of gunzip) {
            scan.tx.check();
            for (const frame of framing.feed(Buffer.from(value), scan)) {
                if (failure) throw failure;
                // 成熟 Parser 的正文循环仍以五百一十二字节为最小推进单位，不能先喂入非整块正文再单独等待短 padding；这
                // 里只延迟最多五百一十一字节并合并下一帧，成员边界必然全部交付后才等待消费者结束，背压仍
                // 逐次遵守。
                const bytes = parserTail.length
                    ? Buffer.concat([parserTail, frame.bytes])
                    : frame.bytes;
                const aligned = bytes.length - (bytes.length % 512);
                parserTail = Buffer.from(bytes.subarray(aligned));
                if (aligned) {
                    const accepted = parser.write(bytes.subarray(0, aligned));
                    if (failure) throw failure;
                    if (!accepted) await once(parser, "drain");
                }
                if (frame.boundary) {
                    if (parserTail.length) scan.tx.fail("PAYLOAD_ARCHIVE_FORMAT");
                    await work;
                    if (failure) throw failure;
                }
                scan.tx.check();
            }
        }
        await pumping;
        if (failure) throw failure;
        framing.finish();
        // 所有普通成员已经在完整块边界结束，最后不足一块的剩余只可能是 guard 已逐字证明的有限零尾；仍交给原 Parser 并遵
        // 守返回的背压，完整 gzip trailer 和 tar 终止检查不会因小缓存被跳过或提前宣布
        // 成功。
        if (parserTail.length) {
            const accepted = parser.write(parserTail);
            if (failure) throw failure;
            if (!accepted) await once(parser, "drain");
        }
        const ended = once(parser, "end");
        parser.end();
        await ended;
        await work;
        if (failure) throw failure;
        await scan.finish();
        return framing.bytes;
    } catch (error) {
        rejected = true;
        if (failure instanceof RuntimePayloadError) throw failure;
        if (error instanceof RuntimePayloadError) throw error;
        if (scan.tx.signal?.aborted) scan.tx.fail("PAYLOAD_CANCELLED");
        const code = error && typeof error === "object" && "code" in error ? error.code : null;
        return scan.tx.fail(
            code === "Z_DATA_ERROR" || code === "Z_BUF_ERROR"
                ? "PAYLOAD_ARCHIVE_CRC"
                : "PAYLOAD_ARCHIVE_FORMAT",
        );
    } finally {
        scan.tx.signal?.removeEventListener("abort", aborted);
        source.destroy();
        gunzip.destroy();
        current?.destroy();
        if (!failure) parser.end();
        try {
            await pumping;
            await work;
        } finally {
            try {
                await handle.close();
            } catch {
                scan.tx.noteCloseFailure();
                if (!rejected) scan.tx.fail("PAYLOAD_IO", "INCOMPLETE");
            }
        }
    }
}
