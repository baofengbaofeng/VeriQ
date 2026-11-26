/**
 * 在已知 Chromium 上把原生出站策略绑定到实际收到的顶层文档，填补请求阶段拦截不覆盖的连接通道。
 * 限量读取浏览器已解码的内容，保留上游状态、Cookie 和独立 CSP 响应头。
 */
import type { CDPSession } from "@playwright/test";

interface ResponseHeader {
    name: string;
    value: string;
}

/**
 * 响应阶段的事件仅用于重建同一个已通过 TLS 的主文档，重定向继续交给现有逐跳请求阶段检查。
 */
export interface SsoDocumentResponse {
    requestId: string;
    responseStatusCode?: number;
    responseStatusText?: string;
    responseErrorReason?: string;
    responseHeaders?: ResponseHeader[];
}

const maxDocumentBytes = 4 * 1024 * 1024;
const chunkBytes = 64 * 1024;
const staleBodyHeaders = new Set(["content-length", "transfer-encoding"]);
const nativeHeader = "connection-allowlist";

/**
 * 只保留与冻结业务来源完全一致的 URLPattern，不允许来源值构造通配模式或报头结构。
 */
export function hasExactPolicyOrigin(origin: string): boolean {
    return /^https?:\/\/(?:[a-z0-9.-]+|\[[0-9a-f:]+\])(?::[0-9]+)?$/u.test(origin);
}

/**
 * 顺序消费受约束的 CDP 流，先判定容量再累积解码内容。流打开后由调用方继续履约或取消原请求。
 */
async function readDocument(session: CDPSession, requestId: string, stopped: () => boolean): Promise<Buffer> {
    const { stream } = (await session.send("Fetch.takeResponseBodyAsStream", { requestId })) as { stream: string };
    const chunks: Buffer[] = [];
    let total = 0;
    try {
        for (;;) {
            if (stopped()) throw new Error("SSO_ORIGIN_NOT_ALLOWED");
            const chunk = (await session.send("IO.read", { handle: stream, size: chunkBytes })) as {
                data: string;
                base64Encoded?: boolean;
                eof: boolean;
            };
            const bytes = Buffer.from(chunk.data, chunk.base64Encoded ? "base64" : "utf8");
            total += bytes.length;
            if (total > maxDocumentBytes || (!bytes.length && !chunk.eof)) throw new Error("SSO_ORIGIN_NOT_ALLOWED");
            chunks.push(bytes);
            if (chunk.eof) return Buffer.concat(chunks, total);
        }
    } finally {
        await session.send("IO.close", { handle: stream });
    }
}

/**
 * 合成的文档响应显式携带原始正文；仅改头或省略正文不能可靠触发该浏览器版本的原生连接限制。
 */
export async function applySsoDocumentPolicy(
    session: CDPSession,
    response: SsoDocumentResponse,
    allowedOrigins: ReadonlySet<string>,
    idpDocument: boolean,
    stopped: () => boolean,
): Promise<void> {
    const { requestId, responseStatusCode: status } = response;
    if (!status || status === 304 || response.responseErrorReason) throw new Error("SSO_ORIGIN_NOT_ALLOWED");
    if ((status >= 300 && status < 400) || status === 204 || status === 205) {
        await session.send("Fetch.continueResponse", { requestId });
        return;
    }
    const originalHeaders = response.responseHeaders;
    if (status < 200 || !originalHeaders) throw new Error("SSO_ORIGIN_NOT_ALLOWED");
    const sites = idpDocument ? [] : [...allowedOrigins].map((origin) => JSON.stringify(origin));
    const policy = `(${["response-origin", ...sites].join(" ")}); redirects=allow; webrtc=block`;
    const existing = originalHeaders.filter(({ name }) => name.toLowerCase() === nativeHeader);
    if (existing.length > 1 || (existing.length === 1 && existing[0]?.value.trim() !== policy))
        throw new Error("SSO_ORIGIN_NOT_ALLOWED");
    const encoding = originalHeaders.filter(({ name }) => name.toLowerCase() === "content-encoding");
    const coding = encoding[0]?.value.trim().toLowerCase();
    // 锁定版实测仅对 gzip 与 Brotli 返回解压内容，不能把未核验的编码假定为已解码。
    if (encoding.length > 1 || (coding !== undefined && !["identity", "gzip", "br"].includes(coding)))
        throw new Error("SSO_ORIGIN_NOT_ALLOWED");

    const body = await readDocument(session, requestId, stopped);
    if (stopped()) throw new Error("SSO_ORIGIN_NOT_ALLOWED");
    const headers = originalHeaders.filter(({ name }) => {
        const lower = name.toLowerCase();
        return !staleBodyHeaders.has(lower) && !(lower === "content-encoding" && coding !== "identity");
    });
    if (!existing.length) headers.push({ name: "Connection-Allowlist", value: policy });
    const sandbox = "worker-src 'none'; child-src 'none'; frame-src 'none'";
    headers.push(
        { name: "Content-Security-Policy", value: idpDocument ? sandbox + "; connect-src 'none'" : sandbox },
        { name: "Content-Length", value: String(body.length) },
    );
    await session.send("Fetch.fulfillRequest", {
        requestId,
        responseCode: status,
        ...(response.responseStatusText === undefined ? {} : { responsePhrase: response.responseStatusText }),
        responseHeaders: headers,
        body: body.toString("base64"),
    });
}
