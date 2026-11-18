/**
 * 本文件是受信任的工作进程注入模块：由监督器复制进 Attempt 工作区：创建执行上下文且永不由 DSL 选取（provider）。
 */
import { join } from "node:path";
// 工作进程加载监督器复制的固定模块，由它读取随任务写入的调用配置和执行快照，再建立本次执行的上下文。
import { readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { canonicalBytes, validateSchema } from "@veriq/contracts";
import { connect } from "node:net";
import { createHttpLifecycle } from "@veriq/runner-sdk";
const settings = JSON.parse(await readFile(new URL("./invocation.json", import.meta.url), "utf8"));
/**
 * 公开函数 contact 与 Attempt 私有代理进行握手：确认工作进程控制通道可用后才继续执行用例（contact）。
 */
export async function contact(message, signal) {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
        const socket = connect(settings.socket);
        const abort = () => {
            socket.destroy();
            reject(new Error("CANCELLED"));
        };
        signal?.addEventListener("abort", abort, { once: true });
        socket.once("close", () => signal?.removeEventListener("abort", abort));
        const chunks = [];
        let bytes = 0,
            complete = false;
        socket.on("connect", () => socket.write(JSON.stringify({ ...message, nonce: settings.nonce }) + "\n"));
        socket.on("error", () => reject(new Error("ATTEMPT_IPC_FAILED")));
        socket.setTimeout(15000, () => {
            socket.destroy();
            reject(new Error("ATTEMPT_IPC_TIMEOUT"));
        });
        socket.on("data", (chunk) => {
            bytes += chunk.length;
            if (bytes > 65536) {
                socket.destroy();
                reject(new Error("IPC_RESPONSE_LIMIT"));
                return;
            }
            chunks.push(chunk);
            if (!chunk.includes(10)) return;
            complete = true;
            socket.end();
            try {
                const frame = Buffer.concat(chunks);
                if (frame.indexOf(10) !== frame.length - 1) throw new Error("INVALID_IPC_FRAME");
                const reply = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frame));
                reply.ok ? resolve(reply.value) : reject(new Error("ATTEMPT_IPC_FAILED"));
            } catch {
                reject(new Error("INVALID_IPC_FRAME"));
            }
        });
        socket.on("end", () => {
            if (!complete) reject(new Error("ATTEMPT_IPC_CLOSED"));
        });
    });
}
/**
 * 原始字节完整组装并通过摘要验证后才解码，分段可能切开一个多字节字符，空段、顺序变化或长度偏差均拒绝。
 */
export async function readStaticDataset(selection, expected, send = contact, budget = { remaining: 16 * 1024 * 1024 }) {
    return readFrames(selection, expected, send, budget);
}
async function readFrames(selection, expected, send, budget, liveId) {
    let offset = 0,
        size,
        id;
    const parts = [];
    do {
        const type = liveId ? "httpDataset" : "dataset";
        const frame = await send(offset ? { type, id, offset } : { type, selection, ...(liveId && { id: liveId }) });
        if (liveId && frame.errorCode)
            throw new Error(
                !validateSchema("ProtectedExecutionErrorCode", frame.errorCode).length
                    ? frame.errorCode
                    : "DATASET_READ_ERROR",
            );
        if (!offset && liveId) {
            if (frame.id !== liveId || validateSchema("Sha256", frame.sha256).length)
                throw new Error("INVALID_DATASET_CHUNK");
            expected = frame.sha256;
        }
        if (!offset) ({ size, id } = frame);
        if (
            !Number.isSafeInteger(size) ||
            size < 1 ||
            size > 16 * 1024 * 1024 ||
            typeof id !== "string" ||
            frame.id !== id ||
            frame.size !== size ||
            frame.offset !== offset ||
            typeof frame.part !== "string" ||
            frame.part.length > 43692
        )
            throw new Error("INVALID_DATASET_CHUNK");
        if (!offset) {
            if (size > budget.remaining) throw new Error("DATASET_TRANSFER_LIMIT");
            budget.remaining -= size;
        }
        const bytes = Buffer.from(frame.part, "base64");
        if (bytes.length !== Math.min(32768, size - offset) || bytes.toString("base64") !== frame.part)
            throw new Error("INVALID_DATASET_CHUNK");
        parts.push(bytes);
        offset += bytes.length;
    } while (offset < size);
    const raw = Buffer.concat(parts, size);
    if (createHash("sha256").update(raw).digest("hex") !== expected) throw new Error("DATASET_HASH_MISMATCH");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
}
/**
 * 编译器需要完整的冻结闭包来复查源摘要，执行用例只需要声明别名的版本；两者都仅在内存中恢复数据正文。
 */
export async function hydrateSource(projected, aliases) {
    const { originalSha256, ...rest } = projected;
    const assets = [];
    const budget = { remaining: 16 * 1024 * 1024 };
    for (const item of projected.assets) {
        if (item.kind !== "DATASET") assets.push(item);
        else if (!aliases || aliases.includes(item.versionId)) {
            const { schema, contentSha256, ...identity } = item;
            const document = await readStaticDataset(
                { selection: "DATASET", versionId: item.versionId },
                contentSha256,
                contact,
                budget,
            );
            assets.push({ ...identity, document });
        }
    }
    const source = { ...rest, schemaVersion: "1.0", assets };
    if (!aliases && createHash("sha256").update(canonicalBytes(source)).digest("hex") !== originalSha256)
        throw new Error("DATASET_HASH_MISMATCH");
    return source;
}
/**
 * 行投影的版本与摘要同时约束恢复过程，没有矩阵数据的用例无需申请行内容，保持原来的执行上下文验证方式。
 */
export async function hydrateExecution(projected) {
    if (projected.schemaVersion !== "2.0") return projected;
    const { selectedRow, ...rest } = projected;
    if (!selectedRow) return { ...rest, schemaVersion: "1.0" };
    if (selectedRow.versionId !== rest.datasetVersionId) throw new Error("ROW_VERSION_MISMATCH");
    const dataRow = await readStaticDataset(
        { selection: "ROW", versionId: selectedRow.versionId, rowKey: selectedRow.rowKey },
        selectedRow.rowSha256,
    );
    if (dataRow.key !== selectedRow.rowKey) throw new Error("ROW_KEY_MISMATCH");
    return { ...rest, schemaVersion: "1.0", dataRow };
}
/**
 * 可信工作进程只把重建的上下文交给本次用例，设备凭证与远程请求均由私有代理完成并受租约约束。
 */
export async function createExecutionContext() {
    const controller = new AbortController();
    const timer = setInterval(
        () =>
            contact({ type: "status" })
                .then((value) => {
                    if (value.cancelled) controller.abort();
                })
                .catch(() => controller.abort()),
        100,
    );
    timer.unref();
    const secrets = new Map();
    const execution = await hydrateExecution(
        JSON.parse(await readFile(new URL("./execution.json", import.meta.url), "utf8")),
    );
    return {
        execution,
        hydrateSource,
        readHttpDataset: async (versionId, parameters, signal) => {
            signal.throwIfAborted();
            const id = randomUUID();
            const cancel = () => {
                void contact({ type: "httpDataset", id, cancel: true }).catch(() => {});
            };
            signal.addEventListener("abort", cancel, { once: true });
            try {
                const response = await readFrames(
                    { versionId, parameters },
                    undefined,
                    (message) => contact(message, signal),
                    { remaining: 3 * 1024 * 1024 },
                    id,
                );
                signal.throwIfAborted();
                if (validateSchema("HttpDatasetResponse", response).length) throw new Error("DATASET_RESPONSE_INVALID");
                return response;
            } catch (error) {
                if (!signal.aborted) cancel();
                throw error;
            } finally {
                signal.removeEventListener("abort", cancel);
            }
        },
        datasetProtected: settings.datasetProtected === true,
        finalizeExecution: async (context) => {
            try {
                // 可信取消后不再启动可选截图，但无论截图是否执行都必须关闭上下文，才能结算物理完成与重试观察。
                const page = context.pages()[0];
                if (!settings.datasetProtected && !controller.signal.aborted && page && !page.isClosed())
                    await page.screenshot({
                        path: join(settings.tmp, "screenshot.png"),
                        timeout: 5000,
                    });
            } finally {
                await context.close();
            }
        },
        signal: controller.signal,
        lifecycle: createHttpLifecycle(),
        credentials: {
            resolve: (reference) => {
                const key = JSON.stringify(reference);
                if (!secrets.has(key)) secrets.set(key, contact({ type: "credential", reference }));
                return secrets.get(key);
            },
        },
        ...(!settings.datasetProtected && {
            downloads: { directory: settings.downloads, maxBytes: settings.downloadLimit },
        }),
        redact: (value) => value,
        onEvent: async (event) => {
            if (event.type === "CASE_FINISHED") clearInterval(timer);
            await contact({
                type: "event",
                event:
                    event.type === "CASE_FINISHED"
                        ? { type: event.type, result: { ...event.result, steps: [] } }
                        : event,
            });
        },
        restrictedEvidence: (evidence) => contact({ type: "restricted", evidence }),
    };
}
