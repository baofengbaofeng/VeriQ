/**
 * 待发送文件只存在当前会话视图，内容按限额读取进提交正文；已保存轮次仅渲染服务端保存的文件元数据。
 */
import { useEffect, useState } from "react";
import { tx } from "../../locale";
import type { AgentSchemas } from "./adapters";

type Upload = NonNullable<AgentSchemas["AgentTurnSubmit"]["attachments"]>[number];
type Metadata = NonNullable<AgentSchemas["AgentTurnDTO"]["attachments"]>[number];
const fileTypes: Partial<Record<string, Upload["mediaType"]>> = {
    txt: "text/plain",
    md: "text/markdown",
    markdown: "text/markdown",
    csv: "text/csv",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
};
const sizes = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

/**
 * 文件选择器接受与后端相同的后缀。浏览器可能漏报文本 MIME，实际内容仍由服务端检查并在失败时阻止发送。
 */
export const agentAttachmentAccept = Object.keys(fileTypes)
    .map((suffix) => `.${suffix}`)
    .join(",");

/**
 * 待发附件使用本地标识切分独立操作区域，文件名和大小投影供预览，真实内容仅在用户提交时读取。
 */
export interface StagedAgentAttachment extends Metadata {
    id: string;
    file: File;
}

/**
 * 选择时以当前待发列表为基础统一校验数量、累计大小和图像开关，失败保留已有列表且不会启动模型请求。
 */
export function stageAgentAttachments(
    current: StagedAgentAttachment[],
    files: readonly File[],
    supportsImages: boolean,
): StagedAgentAttachment[] {
    if (current.length + files.length > 3) throw new Error("AGENT_ATTACHMENT_LIMIT");
    const next = files.map((file) => {
        const dot = file.name.lastIndexOf(".");
        const suffix = dot > 0 ? file.name.slice(dot + 1).toLowerCase() : "";
        const mediaType = Object.hasOwn(fileTypes, suffix) ? fileTypes[suffix] : undefined;
        if (!mediaType || !file.size || [...file.name].length > 180) throw new Error("AGENT_ATTACHMENT_INVALID");
        if (!supportsImages && mediaType.startsWith("image/")) throw new Error("AGENT_IMAGE_UNSUPPORTED");
        return { id: crypto.randomUUID(), file, name: file.name, sizeBytes: file.size, mediaType };
    });
    const combined = [...current, ...next];
    const total = combined.reduce((size, attachment) => size + attachment.sizeBytes, 0);
    const text = combined.reduce((size, item) => size + (item.mediaType.startsWith("text/") ? item.sizeBytes : 0), 0);
    if (total > 2 * 1024 * 1024 || text > 24 * 1024) throw new Error("AGENT_ATTACHMENT_LIMIT");
    return combined;
}

/**
 * 在用户发送时才编码浏览器文件，分段转换限制函数参数数量，切换会话后不再转换已读材料或建立提交编号。
 */
export async function encodeAgentAttachments(
    attachments: StagedAgentAttachment[],
    signal: AbortSignal,
): Promise<Upload[]> {
    const encoded: Upload[] = [];
    for (const { file, name, mediaType } of attachments) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        signal.throwIfAborted();
        const parts: string[] = [];
        for (let index = 0; index < bytes.length; index += 0x4000) {
            parts.push(String.fromCharCode(...bytes.subarray(index, index + 0x4000)));
        }
        encoded.push({ name, mediaType, dataBase64: btoa(parts.join("")) });
    }
    return encoded;
}

function AttachmentThumbnail({ file, mediaType }: Pick<StagedAgentAttachment, "file" | "mediaType">) {
    const [source, setSource] = useState<string>();
    useEffect(() => {
        const url = URL.createObjectURL(file.slice(0, file.size, mediaType));
        setSource(url);
        return () => URL.revokeObjectURL(url);
    }, [file, mediaType]);
    return source ? <img src={source} alt="" /> : null;
}

/**
 * 待发列表给出可移除的本地缩略图，历史列表仅显示名称和原始大小，不会重新读取、下载或重发原文件。
 */
export function AgentAttachmentList({
    attachments,
    remove,
    disabled,
}: {
    attachments: readonly (Metadata | StagedAgentAttachment)[];
    remove?: (id: string) => void;
    disabled?: boolean;
}) {
    if (!attachments.length) return null;
    return (
        <ul className="vq-agent-attachments" aria-label={tx(remove ? "Selected attachments" : "Attachments")}>
            {attachments.map((attachment, index) => {
                const local = "file" in attachment ? attachment : undefined;
                const size = attachment.sizeBytes;
                return (
                    <li key={local?.id ?? index} className="vq-agent-attachment" title={attachment.name}>
                        {local?.mediaType.startsWith("image/") && (
                            <AttachmentThumbnail file={local.file} mediaType={local.mediaType} />
                        )}
                        <span>{attachment.name}</span>
                        <small>{size >= 1024 ? `${sizes.format(size / 1024)} KiB` : `${sizes.format(size)} B`}</small>
                        {local && remove && (
                            <button
                                type="button"
                                disabled={disabled}
                                aria-label={tx("Remove {{name}}", { name: local.name })}
                                onClick={() => remove(local.id)}
                            >
                                ×
                            </button>
                        )}
                    </li>
                );
            })}
        </ul>
    );
}
