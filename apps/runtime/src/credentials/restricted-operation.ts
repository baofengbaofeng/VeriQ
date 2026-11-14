/** 文件后端的有限观察与实际 I/O 生命周期必须分开，截止时间只决定调用者何时得到失败或不确定结果；真实操作及其清理尚未结束时保留同目录隔离，防止下一次调用在上次未知修改仍可能完成时盲目重放。 */
import type { VaultBackendFailure, VaultMutationResult } from "./backend.ts";

/** 观察层只承载凭据后端已有的有限结果及独立密钥缓冲区，不增加通用任务或路径执行能力；持有密钥的成功结果若在观察取消后才到达必须清零，错误结果不能夹带原始文件内容、异常对象或任意业务载荷。 */
export type RestrictedFileResult =
    | { status: "ready" }
    | { status: "ok"; key: Buffer }
    | VaultBackendFailure
    | VaultMutationResult;
const pending = new Map<string, object>();
function erase(value: RestrictedFileResult) {
    if ("key" in value) value.key.fill(0);
}

/** 调用方在整个实际文件操作和清理期间持有目录合作锁，观察层额外隔离同进程其他后端实例；最长五秒或调用者取消后返回，不取消内核请求，后续修改标记必须再次检查取消，只有真实 settle 才解除隔离。 */
export async function observeRestrictedOperation(
    directory: string,
    input: AbortSignal,
    run: (signal: AbortSignal, markMutation: () => void) => Promise<RestrictedFileResult>,
): Promise<RestrictedFileResult> {
    if (!(input instanceof AbortSignal) || input.aborted || pending.has(directory))
        return { status: "failed" };
    const owner = {},
        signal = AbortSignal.any([input, AbortSignal.timeout(5000)]);
    pending.set(directory, owner);
    let mutationStarted = false;
    const failed = (): RestrictedFileResult => ({
        status: mutationStarted ? "mutation-unconfirmed" : "failed",
    });
    const actual = (async (): Promise<RestrictedFileResult> => {
        try {
            return await run(signal, () => {
                if (signal.aborted) throw new Error("RESTRICTED_FILE_OBSERVATION_ABORTED");
                mutationStarted = true;
            });
        } catch {
            return failed();
        } finally {
            if (pending.get(directory) === owner) pending.delete(directory);
        }
    })();
    return new Promise((resolve) => {
        let delivered = false;
        const aborted = () => {
            if (delivered) return;
            delivered = true;
            resolve(failed());
        };
        signal.addEventListener("abort", aborted, { once: true });
        void actual.then((value) => {
            signal.removeEventListener("abort", aborted);
            if (delivered) {
                erase(value);
                return;
            }
            delivered = true;
            resolve(value);
        });
        if (signal.aborted) aborted();
    });
}
