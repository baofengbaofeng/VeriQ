/**
 * 已验证的旧数据集离线包同时携带签名原文与编译器投影，工作进程可在本机分段读取其中同一版本的数据正文。
 */
import { randomUUID } from "node:crypto";
import { canonicalBytes, validateSchema, type AssetSnapshotV1, type ConnectedSourceSnapshotV2 } from "@veriq/contracts";
import { sha256 } from "../execution/release.ts";

/**
 * 每次尝试只接受编译器和执行用例各一次的完整数据读取。校验签名快照及逐版本摘要后才向私有通道返回首帧。
 */
export function signedLegacyDatasetReader(original: AssetSnapshotV1, projected: ConnectedSourceSnapshotV2) {
    // 含可执行入口的编译输出省去仅供发布回执核对的校验目标，签名原文中的其他字段仍须逐字节匹配。
    const retained = { ...original };
    if (retained.entryCaseVersionIds.length) delete retained.validationTarget;
    if (sha256(canonicalBytes(retained)) !== projected.originalSha256) throw new Error("DATASET_HASH_MISMATCH");
    if (original.assets.some((asset) => asset.kind === "DATASET" && asset.document.schemaVersion !== "1.0"))
        throw new Error("OFFLINE_DATASET_VERSION_UNSUPPORTED");
    const reads = new Map<string, number>();
    let remaining = 2 * 16 * 1024 * 1024;
    let transfer: { bytes: Buffer; id: string; offset: number } | undefined;
    return (message: Record<string, unknown>) => {
        if (message.type !== "dataset") throw new Error("INVALID_DATASET_TRANSFER");
        if (message.selection !== undefined) {
            if (transfer || message.offset !== undefined || message.id !== undefined)
                throw new Error("INVALID_DATASET_TRANSFER");
            const selection = message.selection as { selection?: unknown; versionId?: unknown } | null;
            if (
                validateSchema("StaticDatasetSelection", selection).length ||
                selection?.selection !== "DATASET" ||
                typeof selection.versionId !== "string"
            )
                throw new Error("INVALID_DATASET_TRANSFER");
            const { versionId } = selection;
            const asset = original.assets.find((item) => item.versionId === versionId);
            const descriptor = projected.assets.find((item) => item.versionId === versionId);
            if (asset?.kind !== "DATASET" || descriptor?.kind !== "DATASET") throw new Error("BUNDLE_DATASET_MISSING");
            const count = reads.get(versionId) ?? 0;
            if (count >= 2) throw new Error("DATASET_TRANSFER_LIMIT");
            const bytes = Buffer.from(canonicalBytes(asset.document));
            if (bytes.length > 16 * 1024 * 1024 || bytes.length > remaining) throw new Error("DATASET_TRANSFER_LIMIT");
            if (sha256(bytes) !== descriptor.contentSha256) throw new Error("DATASET_HASH_MISMATCH");
            reads.set(versionId, count + 1);
            remaining -= bytes.length;
            transfer = { bytes, id: randomUUID(), offset: 0 };
        } else if (!transfer || message.id !== transfer.id || message.offset !== transfer.offset)
            throw new Error("INVALID_DATASET_TRANSFER");
        const { bytes, id, offset } = transfer;
        const end = Math.min(offset + 32768, bytes.length);
        const part = bytes.subarray(offset, end).toString("base64");
        transfer.offset = end;
        if (end === bytes.length) transfer = undefined;
        return { id, size: bytes.length, offset, part };
    };
}
