// 待定请求在档案排他锁内发布，只有平台确认本机提交后才允许首次发起网络认领，重启继续使用原请求标识。
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { open, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { validateSchema, type PlatformComponents } from "@veriq/contracts";
import { WindowsAttemptJournal } from "../execution/windows-journal.ts";
import { privateDirectory, readBoundedFile, removePrivate } from "../offline/config.ts";

type ClaimRequest = PlatformComponents["schemas"]["ClaimRequest"];
const pendingName = "claim-request.json";

async function syncPath(path: string) {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        await handle.sync();
    } finally {
        await handle.close();
    }
}

async function publish(directory: string, name: string, value: string) {
    const temporary = `.${randomUUID()}.tmp`;
    if (process.platform === "darwin") {
        const { darwinNative } = await import("../native/darwin.ts");
        const parent = darwinNative().openPrivateDirectory(directory, false);
        try {
            parent.replace(name, temporary, Buffer.from(value), 65536);
        } finally {
            parent.close();
        }
    } else {
        const staged = join(directory, temporary);
        await writeFile(staged, value, { flag: "wx", mode: 0o600, flush: true });
        await rename(staged, join(directory, name));
        await syncPath(directory);
    }
}

async function readFileRequest(root: string): Promise<ClaimRequest | undefined> {
    let bytes: Buffer;
    try {
        bytes = await readBoundedFile(join(root, pendingName), 65536, process.platform !== "linux");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
    }
    let request: unknown;
    try {
        request = JSON.parse(bytes.toString("utf8"));
    } catch {
        throw new Error("CLAIM_REQUEST_RECOVERY_REQUIRED");
    }
    if (validateSchema("ClaimRequest", request).length) throw new Error("CLAIM_REQUEST_RECOVERY_REQUIRED");
    return request as ClaimRequest;
}

async function withWindowsJournal<T>(root: string, operation: (journal: WindowsAttemptJournal) => Promise<T> | T) {
    const journal = await WindowsAttemptJournal.open(root);
    try {
        return await operation(journal);
    } finally {
        journal.close();
    }
}

export async function readPending(root: string, observeOnly = false): Promise<ClaimRequest | undefined> {
    if (process.platform !== "win32") {
        const saved = await readFileRequest(root);
        if (saved && !observeOnly) {
            // 正式名可见时，前一次发布仍可能在目录刷新前中断；重放前先确认旧文件及父目录都已持久提交。
            await syncPath(join(root, pendingName));
            await syncPath(root);
        }
        return saved;
    }
    return withWindowsJournal(root, async (journal) => {
        const active = journal.pendingRequest();
        if (active) return active;
        const legacy = await readFileRequest(root);
        if (!legacy || observeOnly) return legacy;
        journal.publishRequest(legacy, true);
        // 数据库同时提交原始请求和导入标记，确保旧文件名在掉电后重新出现时也不会重复发送已经结算的认领。
        await removePrivate(root, pendingName);
        return journal.pendingRequest();
    });
}

export function publishPending(root: string, request: ClaimRequest) {
    if (process.platform === "win32") return withWindowsJournal(root, (journal) => journal.publishRequest(request));
    return publish(root, pendingName, JSON.stringify(request));
}

export async function clearPending(root: string) {
    if (process.platform === "win32") return withWindowsJournal(root, (journal) => journal.clearRequest());
    if (process.platform !== "linux") await removePrivate(root, pendingName);
    else {
        await unlink(join(root, pendingName));
        await syncPath(root);
    }
}

export async function preserveForeignRequest(root: string, request: ClaimRequest) {
    if (process.platform === "win32") return withWindowsJournal(root, (journal) => journal.clearRequest(request));
    const directory = join(root, "unresolved-claims");
    await privateDirectory(directory);
    await syncPath(root);
    const name = `${request.runnerId}-${request.clientRequestId}.json`;
    const value = JSON.stringify(request);
    try {
        const saved = await readBoundedFile(join(directory, name), 65536, true);
        if (saved.toString("utf8") !== value) throw new Error("CLAIM_REQUEST_ARCHIVE_CONFLICT");
        await syncPath(directory);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await publish(directory, name, value);
    }
    await clearPending(root);
}
