import { join } from "node:path";
import lockfile from "proper-lockfile";
import { VaultFiles } from "../../../runtime/src/credentials/files.ts";
import { requireStoppedHistory } from "../../../runtime/src/execution/stopped-history.ts";
import { LocalStore } from "../../../runtime/src/offline/store.ts";

/** 升级准备复用凭据迁移已有的持续停止边界而不取消任何活动任务，在线 Agent 合作锁与 SQLite 写事务一起阻止新的执行拥有者；未知、隔离或没有真实排空证明的历史均继续拒绝，不能以一次 status 为空代替安全替换。
 * 调用者必须已经持有桌面后台排他所有权并封住本实例的新命令。
 * 在线历史使用已有有限只读验证器，不发网络请求、不恢复进程或发送终止信号。
 * 离线 SQLite 的 holdIdle 拒绝任何持久占用，包含 QUARANTINED 和未知准备状态。
 * 返回的释放函数只退休本次实际取得的事务与锁，不删除任何日志、数据库或凭据。
 * Agent 退出时释放这些合作资源，原生安装器仍独立拒绝当时实际运行的产品进程。
 */
export async function holdMaintenance(root: string): Promise<() => Promise<void>> {
    const owner = await VaultFiles.acquire(join(root, "agent-owner"));
    let release: (() => Promise<void>) | undefined;
    let store: LocalStore | undefined;
    let idle: (() => void) | undefined;
    try {
        release = await lockfile.lock(join(root, "agent-owner"), { realpath: false, retries: 0 });
        await requireStoppedHistory(join(root, "agent"));
        store = await LocalStore.open(join(root, "offline"));
        idle = store.holdIdle();
    } catch (error) {
        try {
            idle?.();
        } finally {
            try {
                store?.close();
            } finally {
                try {
                    await release?.();
                } finally {
                    await owner.close();
                }
            }
        }
        throw error;
    }
    let held = true;
    return async () => {
        if (!held) return;
        held = false;
        try {
            idle?.();
        } finally {
            try {
                store?.close();
            } finally {
                try {
                    await release?.();
                } finally {
                    await owner.close();
                }
            }
        }
    };
}
