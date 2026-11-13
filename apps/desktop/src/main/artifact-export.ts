import { rm } from "node:fs/promises";

/** 原始证据的临时导出只在一次宿主动作期间存在，调用方必须先验证该路径属于当前私有 exports 目录；原生保存取消、查看失败或正常完成都使用同一清理边界，删除副本而不触碰持久报告中的原始文件。 */
export async function withArtifactExport<T>(path: string, work: () => Promise<T>): Promise<T> {
    try {
        return await work();
    } finally {
        await rm(path, { force: true });
    }
}
