/** 桌面迁移需要区分本进程实际持有的后台锁与外部仍活跃的后台，能力只在成功获取真实合作锁后颁发；私有映射保存根路径和活跃状态，配置对象、布尔标志或克隆对象不能伪造已经取得的停止协调权。 */
import { join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { VaultFiles } from "./files.ts";

/** 此不透明对象仅表示当前进程已取得指定档案的桌面后台合作锁，不能用于停止进程或跳过业务执行门闩；释放后立即失效，迁移仍必须另持在线 Agent 和档案事务锁来阻止其他执行与凭据写入。 */
export type DesktopProfileOwner = Readonly<{ kind: "desktop-profile-owner" }>;
const owners = new WeakMap<DesktopProfileOwner, { directory: string; active: boolean }>();

/** 取得桌面后台所有权使用现有固定锁目录和严格私有目录校验，只有实际加锁成功才创建能力；返回的释放函数先撤销能力再释放合作锁，未知释放错误不能让旧对象继续授权后续凭据迁移。 */
export async function acquireDesktopProfileOwner(directory: string) {
    const canonical = resolve(directory);
    const files = await VaultFiles.acquire(join(canonical, "desktop-owner"));
    await files.close();
    {
        const unlock = await lockfile.lock(join(canonical, "desktop-owner"), {
            realpath: false,
            retries: 0,
        });
        const owner: DesktopProfileOwner = Object.freeze({ kind: "desktop-profile-owner" });
        const state = { directory: canonical, active: true };
        owners.set(owner, state);
        return {
            owner,
            /** 释放动作先撤销内存能力，随后释放实际合作锁，确保释放异常不会让旧对象继续授权迁移；调用方仍须处理本次错误，不能把能力失效误当作操作系统或其他后台已经完成停止与资源清理。 */
            async release() {
                state.active = false;
                await unlock();
            },
        };
    }
}

/** 检查必须命中当前进程的真实能力记录并匹配规范根路径，公开属性只作类型提示而不构成授权；迁移入口据此决定复用自身已经持有的桌面锁，任何伪造、跨档案或已释放能力都直接失败关闭。 */
export function ownsDesktopProfile(owner: DesktopProfileOwner, directory: string): boolean {
    const state = owners.get(owner);
    return state?.active === true && state.directory === resolve(directory);
}
