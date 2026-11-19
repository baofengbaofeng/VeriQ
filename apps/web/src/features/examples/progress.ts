import type { ImportProgress, SampleKey } from "./types";
import { sampleOrder } from "./types";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 浏览器恢复文件只解码明确白名单的非秘密字段，忽略任意注入键，来源绑定仍由导入器比较；没有Cookie、token、完整请求正文
 * 或可执行表达式进入保存或返回的数据对象。
 */
export function readProgress(key: string, workspaceId: string): ImportProgress | null {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return null;
    const item = value as Record<string, unknown>;
    if (item.workspaceId !== workspaceId || typeof item.fingerprint !== "string" || item.fingerprint.length > 65536)
        return null;
    const result: ImportProgress = { fingerprint: item.fingerprint, workspaceId, versions: {} };
    if (typeof item.adapterVersion === "string" && uuid.test(item.adapterVersion))
        result.adapterVersion = item.adapterVersion;
    if (typeof item.planId === "string" && uuid.test(item.planId)) result.planId = item.planId;
    for (const name of ["business", "fixture"] as const) {
        const candidate = item[name];
        if (candidate && typeof candidate === "object") {
            const binding = candidate as Record<string, unknown>;
            if (
                typeof binding.secretRef === "string" &&
                /^[A-Za-z_][A-Za-z0-9_-]{0,159}$/.test(binding.secretRef) &&
                typeof binding.versionId === "string" &&
                uuid.test(binding.versionId)
            ) {
                result[name] = { secretRef: binding.secretRef, versionId: binding.versionId };
            }
        }
    }
    if (item.versions && typeof item.versions === "object") {
        const versions = item.versions as Record<SampleKey, unknown>;
        for (const name of sampleOrder) {
            const candidate = versions[name];
            if (typeof candidate === "string" && uuid.test(candidate)) result.versions[name] = candidate;
        }
    }
    return result;
}

/**
 * 保存入口只接受导入器维护的非秘密进度，使用当前员工和空间专属sessionStorage键；关闭浏览器会话自然失效，保存失败由UI显
 * 示且不会把写入服务器的实际事实改成成功或失败。
 */
export function writeProgress(key: string, progress: ImportProgress): void {
    const safe: ImportProgress = {
        fingerprint: progress.fingerprint,
        workspaceId: progress.workspaceId,
        versions: { ...progress.versions },
        ...(progress.adapterVersion ? { adapterVersion: progress.adapterVersion } : {}),
        ...(progress.business ? { business: { ...progress.business } } : {}),
        ...(progress.fixture ? { fixture: { ...progress.fixture } } : {}),
        ...(progress.planId ? { planId: progress.planId } : {}),
    };
    sessionStorage.setItem(key, JSON.stringify(safe));
}
