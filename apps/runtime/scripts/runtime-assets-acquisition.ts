import { RuntimePayloadError, type Arch, type Ref } from "./runtime-payload-inputs.ts";
import https from "node:https";
import { createHash } from "node:crypto";
import type { ClientRequest, IncomingMessage } from "node:http";
import { InputReader, freeze, fail } from "./runtime-payload-tree.ts";
import { ArchiveTransaction } from "./runtime-payload-transaction.ts";
import type { StageOptions } from "./runtime-payload-archive.ts";
import {
    OFFICIAL_ASSETS,
    assetArch,
    assetOptions,
    assetUrls,
    parseSourceObservation,
    bindAssetSources,
    checkNodeChecksum,
    assetBytes,
    writeAssetJson,
    assetFailure,
    type SourceObservation,
    type FetchFact,
    type Hop,
    type FetchEvidence,
    type AssetsObservationInput,
    type AssetsAcquisitionResult,
} from "./runtime-assets-observation.ts";

/**
 * 原响应头按大小写无关名称收集且保留重复事实，只允许单个无歧义值进入固定字段判断；不接受库合并后的宽松 headers 对象，也
 * 不向日志写入其它响应头、错误页、凭据或远端未经控制的消息。
 */
function header(raw: readonly string[], name: string): string | null {
    if (raw.length % 2) fail("PAYLOAD_IO");
    const values: string[] = [];
    for (let i = 0; i < raw.length; i += 2)
        if (raw[i]!.toLowerCase() === name) values.push(raw[i + 1]!);
    if (values.length > 1) fail("PAYLOAD_IO");
    return values[0] ?? null;
}
/**
 * 声明长度必须是单个十进制安全整数且不能包含符号、空格或逗号，正文最终仍单独累计实际长度；可空模式只供重定向无正文事实
 * 使用，真正二百响应永远要求显式 Content-Length 并匹配冻结精确长度。
 */
function length(raw: readonly string[], required: boolean): number | null {
    const value = header(raw, "content-length");
    if (value === null && !required) return null;
    if (value === null || !/^(0|[1-9][0-9]*)$/.test(value)) fail("PAYLOAD_IO");
    const number = Number(value);
    if (!Number.isSafeInteger(number)) fail("PAYLOAD_IO");
    return number;
}
/**
 * 生产每份最终响应都经这个实际流消费者核状态、原头、精确长度和真实摘要，再以六十四 KiB 块进入事务；null 摘要只代表
 * Chrome 没有独立预期摘要，测试可用真实微型正文直接检验相同路径而不改官方常量。
 */
export async function* validatedAssetBody(
    response: {
        statusCode: number;
        rawHeaders: readonly string[];
        body: AsyncIterable<Uint8Array>;
    },
    expected: Readonly<{ sizeBytes: number; sha256: string | null; maximumBytes: number }>,
    signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
    const { sizeBytes, sha256, maximumBytes } = expected;
    if (
        ![sizeBytes, maximumBytes].every((n) => Number.isSafeInteger(n) && n >= 0) ||
        sizeBytes > maximumBytes
    )
        fail("PAYLOAD_LIMIT");
    if (sha256 !== null && !/^[a-f0-9]{64}$/.test(sha256)) fail("PAYLOAD_INPUT_INVALID");
    const check = () => {
        if (signal?.aborted) fail("PAYLOAD_CANCELLED");
    };
    check();
    if (
        response.statusCode !== 200 ||
        ![null, "identity"].includes(header(response.rawHeaders, "content-encoding")) ||
        header(response.rawHeaders, "transfer-encoding") !== null
    )
        fail("PAYLOAD_IO");
    if (length(response.rawHeaders, true) !== sizeBytes) fail("PAYLOAD_ARCHIVE_HASH");
    const digest = createHash("sha256");
    let actual = 0;
    for await (const data of response.body) {
        check();
        if (!(data instanceof Uint8Array)) fail("PAYLOAD_IO");
        actual += data.byteLength;
        if (actual > sizeBytes || actual > maximumBytes) fail("PAYLOAD_LIMIT");
        for (let offset = 0; offset < data.byteLength; offset += 65536) {
            check();
            const chunk = data.subarray(offset, offset + 65536);
            digest.update(chunk);
            yield chunk;
        }
    }
    check();
    if (actual !== sizeBytes || (sha256 !== null && digest.digest("hex") !== sha256))
        fail("PAYLOAD_ARCHIVE_HASH");
}
/**
 * 环境代理及附加 CA 会改变本片冻结的 HTTPS 获取上下文，因此显式出现就拒绝而不是猜测其值是否安全；CI 清除同一列表后启动
 * 真实 CLI，默认系统 CA 本身仍是宿主信任事实而非本工具认证的发布者证明。
 */
export function assertAssetTransportEnvironment(): void {
    for (const key of [
        "NODE_TLS_REJECT_UNAUTHORIZED",
        "NODE_EXTRA_CA_CERTS",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
        "NODE_USE_ENV_PROXY",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
    ])
        if (Object.hasOwn(process.env, key)) fail("PAYLOAD_INPUT_INVALID");
}
/**
 * 每次请求拥有自己的 headers 期限及响应无进展期限，关闭事实在创建后立即注册以免丢失 close；重定向和错误页从不被排空记录
 * ，owner 销毁后必须等到 close 确认，否则标记事务保留而不能递归删除仍可能写入的目录
 * 。
 */
async function request(
    tx: ArchiveTransaction,
    url: string,
    consume: (response: IncomingMessage) => Promise<FetchFact | string>,
    signal: AbortSignal,
): Promise<FetchFact | string> {
    let req: ClientRequest | undefined,
        response: IncomingMessage | undefined,
        reqClosed: Promise<void> | undefined,
        resClosed: Promise<void> | undefined;
    let primary: unknown, timer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => {
        req?.destroy(
            new RuntimePayloadError(tx.signal?.aborted ? "PAYLOAD_CANCELLED" : "PAYLOAD_IO"),
        );
        response?.destroy();
    };
    try {
        const received = new Promise<IncomingMessage>((resolve, reject) => {
            req = https.request(
                url,
                {
                    method: "GET",
                    headers: { "Accept-Encoding": "identity" },
                    maxHeaderSize: 16384,
                    agent: false,
                },
                (value) => {
                    response = value;
                    resClosed = new Promise((resolve) => value.once("close", resolve));
                    value.on("error", () => {});
                    clearTimeout(timer);
                    value.setTimeout(30000, abort);
                    resolve(value);
                },
            );
            reqClosed = new Promise((resolve) => req!.once("close", resolve));
            req.once("error", reject);
            timer = setTimeout(() => {
                abort();
                reject(new RuntimePayloadError("PAYLOAD_IO"));
            }, 30000);
            req.end();
        });
        signal.addEventListener("abort", abort, { once: true });
        tx.check();
        if (signal.aborted) {
            abort();
            tx.fail("PAYLOAD_IO");
        }
        const res = await received;
        tx.check();
        return await consume(res);
    } catch (error) {
        primary = error;
        if (tx.signal?.aborted) tx.fail("PAYLOAD_CANCELLED");
        if (error instanceof RuntimePayloadError) throw error;
        return tx.fail("PAYLOAD_IO");
    } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        req?.destroy();
        response?.destroy();
        let closeTimer: ReturnType<typeof setTimeout> | undefined;
        const confirmed = await Promise.race([
            Promise.all([reqClosed, resClosed]).then(() => true),
            new Promise<false>((resolve) => {
                closeTimer = setTimeout(() => resolve(false), 5000);
            }),
        ]);
        clearTimeout(closeTimer);
        if (!confirmed) {
            tx.noteCloseFailure();
            if (!primary) tx.fail("PAYLOAD_IO", "INCOMPLETE");
        }
    }
}
/**
 * 固定下载阶段顺序消费单个响应流，Node 与 checksum 完全拒绝跳转，Chrome 最多一次且只允许精确 Google 同架构目标；最终
 * body Ref 只有真实完整写入后才返回，部分正文不会进入成功获取证据或伪造结
 * 果。
 */
async function fetchAsset(
    tx: ArchiveTransaction,
    requestedUrl: string,
    destination: string,
    expected: Readonly<{ sizeBytes: number; sha256: string | null; maximumBytes: number }>,
    redirect: string | null,
    totalSignal: AbortSignal,
): Promise<FetchFact> {
    const hops: Hop[] = [];
    let current = requestedUrl;
    let step = "CHECKSUM";
    if (destination === "archives/node.tar.gz") step = "NODE";
    if (destination === "archives/chrome.zip") step = "CHROME";
    const progress = { step, bytes: 0 };
    acquisitionProgress.set(tx, progress);
    const controller = new AbortController(),
        signal = AbortSignal.any([
            controller.signal,
            totalSignal,
            ...(tx.signal ? [tx.signal] : []),
        ]);
    const deadline = setTimeout(() => controller.abort(), 600000);
    const cancel = () => controller.abort();
    tx.signal?.addEventListener("abort", cancel, { once: true });
    try {
        for (let index = 0; index < 2; index++) {
            tx.check();
            if (signal.aborted) tx.fail("PAYLOAD_IO");
            const result = await request(
                tx,
                current,
                async (response) => {
                    const status = response.statusCode ?? 0;
                    if ([301, 302, 303, 307, 308].includes(status)) {
                        const location = header(response.rawHeaders, "location");
                        if (!redirect || index !== 0 || location !== redirect)
                            tx.fail("PAYLOAD_IO");
                        hops.push({
                            url: current,
                            status: status as Hop["status"],
                            location,
                            contentLength: length(response.rawHeaders, false),
                        });
                        return location;
                    }
                    if (status !== 200) tx.fail("PAYLOAD_IO");
                    const body = await tx.write(
                        destination,
                        validatedAssetBody(
                            {
                                statusCode: status,
                                rawHeaders: response.rawHeaders,
                                body: countedBody(response, progress),
                            },
                            expected,
                            signal,
                        ),
                    );
                    hops.push({
                        url: current,
                        status: 200,
                        location: null,
                        contentLength: body.sizeBytes,
                    });
                    return freeze({ requestedUrl, hops, body });
                },
                signal,
            );
            if (typeof result !== "string") return result;
            current = result;
        }
        return tx.fail("PAYLOAD_IO");
    } catch (error) {
        if (signal.aborted && !tx.signal?.aborted) return tx.fail("PAYLOAD_IO");
        throw error;
    } finally {
        clearTimeout(deadline);
        tx.signal?.removeEventListener("abort", cancel);
    }
}
const acquisitionProgress = new WeakMap<ArchiveTransaction, { step: string; bytes: number }>();
const acquisitionFailures = new WeakMap<object, Readonly<{ step: string; bytes: number }>>();
/**
 * 失败计数只记录当前固定阶段实际收到的正文块字节，不保存远端正文、响应头或请求凭据；该内部生成器位于真实响应与验证器之
 * 间，因此超声明的最后一块也计入失败事实，而不会误记为已接受或已写入字节。
 */
async function* countedBody(response: AsyncIterable<Uint8Array>, progress: { bytes: number }) {
    for await (const chunk of response) {
        progress.bytes += chunk.byteLength;
        yield chunk;
    }
}
/**
 * CLI 仅可读取本次真实异常绑定的有界下载失败计数，映射没有公开写入器或调用者 callback，因此不能替换传输与信任政策；返回
 * 内容只含固定阶段和实际收到字节，不改变统一 RuntimePayloadError 的冻结 DT
 * O 与首错语义。
 */
export function assetAcquisitionFailure(
    error: unknown,
): Readonly<{ step: string; bytes: number }> | null {
    return error && typeof error === "object" ? (acquisitionFailures.get(error) ?? null) : null;
}
/**
 * 唯一顶层获取入口同步固定架构、来源和 options，再核真实来源证据及十九项宿主源码才可创建任何请求；官方描述符、URL 和限
 * 额没有可覆盖参数，输出只包含六个必要文件与默认空事务目录，不生成 Runtime 或批准布局。
 */
export async function acquireMacRuntimeAssets(
    arch: Arch,
    source: SourceObservation,
    options: StageOptions,
): Promise<AssetsAcquisitionResult> {
    const target = assetArch(arch),
        binding = parseSourceObservation(source),
        o = assetOptions(options);
    const tx = new ArchiveTransaction(o.inputRoot, o.outputParent, o.candidateName, o.signal);
    tx.phase = "INPUTS";
    const reader = new InputReader(o.inputRoot, o.signal, []),
        controller = new AbortController();
    const cancel = () => controller.abort();
    o.signal?.addEventListener("abort", cancel, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        await reader.initialize();
        const host = await bindAssetSources(reader, binding, target);
        await reader.finish();
        await tx.initialize();
        await tx.observeRefs([binding.evidence]);
        await reader.finish();
        await tx.plan(
            binding.evidence.sizeBytes +
                OFFICIAL_ASSETS.checksum.sizeBytes +
                OFFICIAL_ASSETS[target].nodeBytes +
                OFFICIAL_ASSETS[target].chromeBytes +
                65536,
            6,
        );
        await tx.snapshot(binding.evidence, "evidence/source.json");
        await host.finish();
        await tx.finishSources();
        tx.phase = "INTAKE";
        timer = setTimeout(() => controller.abort(), 900000);
        const urls = assetUrls(target),
            pin = OFFICIAL_ASSETS[target];
        const checksum = await fetchAsset(
            tx,
            OFFICIAL_ASSETS.checksum.url,
            "evidence/SHASUMS256.txt",
            {
                sizeBytes: OFFICIAL_ASSETS.checksum.sizeBytes,
                sha256: OFFICIAL_ASSETS.checksum.sha256,
                maximumBytes: 65536,
            },
            null,
            controller.signal,
        );
        const checksumReader = new InputReader(tx.scratch, o.signal, []);
        await checksumReader.initialize();
        checkNodeChecksum(await checksumReader.input(checksum.body.path));
        await checksumReader.finish();
        const node = await fetchAsset(
            tx,
            urls.node,
            "archives/node.tar.gz",
            { sizeBytes: pin.nodeBytes, sha256: pin.nodeSha, maximumBytes: 64 * 1024 ** 2 },
            null,
            controller.signal,
        );
        const chrome = await fetchAsset(
            tx,
            urls.chrome,
            "archives/chrome.zip",
            { sizeBytes: pin.chromeBytes, sha256: null, maximumBytes: 256 * 1024 ** 2 },
            urls.chromeRedirect,
            controller.signal,
        );
        const evidence: FetchEvidence = {
            schemaVersion: 1,
            kind: "OFFICIAL_ASSET_FETCH_EVIDENCE",
            arch: target,
            sourceStatus: "UNREVIEWED_SOURCE",
            nodeChecksumText: checksum,
            node,
            chrome,
            nodeCheck: "MATCHED_PINNED_HTTPS_TEXT",
            chromeCheck: "BODY_HASH_OBSERVED_ONLY",
            publisherSignature: "NOT_VERIFIED",
        };
        const fetchEvidence = await writeAssetJson(tx, "evidence/fetch.json", evidence);
        const input: AssetsObservationInput = {
            schemaVersion: 1,
            kind: "MAC_RUNTIME_ASSETS_OBSERVATION_INPUT",
            arch: target,
            nodeVersion: "24.22.1",
            chromeVersion: "158.0.8127.18",
            playwrightVersion: "1.65.0",
            revision: "1254",
            source: binding,
            node: node.body,
            chrome: chrome.body,
            fetchEvidence,
        };
        const ref = await writeAssetJson(tx, "assets-input.json", input);
        await reader.finish();
        await host.finish();
        await tx.finishSources();
        await tx.audit();
        tx.phase = "PUBLISH";
        const cleanup = await tx.publish();
        return freeze({
            kind: "MAC_RUNTIME_ASSETS_ACQUISITION_RESULT",
            directory: tx.directory,
            input: ref,
            status: "UNREVIEWED_SOURCE",
            committed: true,
            cleanup,
        });
    } catch (error) {
        try {
            return await assetFailure(tx, error);
        } catch (failure) {
            if (failure && typeof failure === "object")
                acquisitionFailures.set(
                    failure,
                    Object.freeze({
                        ...(acquisitionProgress.get(tx) ?? { step: "SOURCE", bytes: 0 }),
                    }),
                );
            throw failure;
        }
    } finally {
        clearTimeout(timer);
        o.signal?.removeEventListener("abort", cancel);
    }
}
