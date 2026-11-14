/** 整体凭据退休只处理显式确认的有限密文成员与确切系统密钥版本，非秘密意图在任何删除前落盘；完成标记持续阻止普通访问重新初始化，未知服务结果保留精确事实，不声称远端恰好一次或磁盘物理擦除。 */
import { createHash } from "node:crypto";
import type { VaultKeyBackend } from "./backend.ts";
import type { VaultFiles } from "./files.ts";

const NAME = "deletion.json";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const RECORD = /^record-[0-9a-f-]{36}\.json$/;
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
function fail(status: string): never {
    throw new Error(`VAULT_${status.replaceAll("-", "_").toUpperCase()}`);
}
/** 删除计划只包含已核验的档案身份、清单摘要和过去所有密钥版本的非秘密校验值，记录列表精确指向本档案密文；字段不能由渲染器或通用路径请求指定，构造者必须已经取得同一停止所有权和档案锁。 */
export type CredentialDeletion = {
    version: 1;
    profileId: string;
    manifestHash: string;
    state: "pending" | "deleted";
    records: string[];
    keys: Array<{ keyVersion: string; keyHash: string; status: "pending" | "absent" }>;
};
/** 删除日志每次从私有文件严格解析，有限唯一成员和确切字段结构阻止损坏元数据授权任意删除；只将真实缺失解释为没有删除意图，解析失败或已完成却仍记录未确认密钥都不能进入普通初始化。 */
export async function readCredentialDeletion(
    files: VaultFiles,
): Promise<CredentialDeletion | undefined> {
    const wire = await files.read(NAME);
    if (wire === undefined) return undefined;
    let value: CredentialDeletion;
    try {
        value = JSON.parse(wire) as CredentialDeletion;
    } catch {
        return fail("deletion-corrupt");
    }
    if (
        !value ||
        Object.keys(value).sort().join() !== "keys,manifestHash,profileId,records,state,version" ||
        value.version !== 1 ||
        typeof value.profileId !== "string" ||
        !UUID.test(value.profileId) ||
        typeof value.manifestHash !== "string" ||
        !HASH.test(value.manifestHash) ||
        !["pending", "deleted"].includes(value.state) ||
        !Array.isArray(value.records) ||
        value.records.length > 20000 ||
        !value.records.every((name) => typeof name === "string" && RECORD.test(name)) ||
        new Set(value.records).size !== value.records.length ||
        !Array.isArray(value.keys) ||
        value.keys.length < 1 ||
        value.keys.length > 129 ||
        value.keys.some(
            (key) =>
                !key ||
                Object.keys(key).sort().join() !== "keyHash,keyVersion,status" ||
                typeof key.keyVersion !== "string" ||
                !UUID.test(key.keyVersion) ||
                typeof key.keyHash !== "string" ||
                !HASH.test(key.keyHash) ||
                !["pending", "absent"].includes(key.status),
        ) ||
        new Set(value.keys.map((key) => key.keyVersion)).size !== value.keys.length ||
        (value.state === "deleted" && value.keys.some((key) => key.status !== "absent"))
    )
        fail("deletion-corrupt");
    return value;
}
/** 所有普通消费与空初始化恢复都必须先观察删除标记，尚未完成和已经完成分别返回稳定错误；该函数只读取元数据，不触发密钥访问、文件恢复或重新生成档案，因此调用方不能无意撤销用户的删除决定。 */
export async function requireNotDeleting(files: VaultFiles): Promise<void> {
    const journal = await readCredentialDeletion(files);
    if (journal)
        fail(journal.state === "deleted" ? "profile-deleted" : "profile-deletion-required");
}
async function observedKey(
    backend: VaultKeyBackend,
    journal: CredentialDeletion,
    entry: CredentialDeletion["keys"][number],
): Promise<boolean> {
    const result = await backend.get(
        { profileId: journal.profileId, keyVersion: entry.keyVersion },
        AbortSignal.timeout(5000),
    );
    if (result.status === "missing") return false;
    if (result.status !== "ok") fail(result.status);
    try {
        if (result.key.length !== 32 || digest(result.key) !== entry.keyHash) fail("key-conflict");
    } finally {
        result.key.fill(0);
    }
    return true;
}
/** 退休先核对所有现存精确密钥并持久化意图，再删除全部密文与索引，最后逐版本删除和读回确认缺失；每次显式继续先读实际状态，已缺失时不重放删除，晚出现的旧意图也必须匹配原摘要才能退休。 */
export async function retireCredentialFiles(
    files: VaultFiles,
    backend: VaultKeyBackend,
    journal: CredentialDeletion,
): Promise<void> {
    if (
        !(await files.containsOnly([
            NAME,
            "profile.json",
            "initialization.json",
            ...journal.records,
        ]))
    )
        fail("deletion-data-conflict");
    const manifest = await files.read("profile.json");
    if (manifest !== undefined && digest(manifest) !== journal.manifestHash)
        fail("deletion-conflict");
    let present = false;
    for (const entry of journal.keys)
        if (await observedKey(backend, journal, entry)) present = true;
    if (journal.state === "deleted" && !present) {
        if (!(await files.containsOnly([NAME]))) fail("deletion-data-conflict");
        return;
    }
    journal.state = "pending";
    await files.write(NAME, JSON.stringify(journal));
    for (const name of [...journal.records, "profile.json", "initialization.json"]) {
        await files.remove(name);
        if ((await files.read(name)) !== undefined) fail("deletion-unconfirmed");
    }
    for (const entry of journal.keys) {
        const scope = { profileId: journal.profileId, keyVersion: entry.keyVersion };
        if (await observedKey(backend, journal, entry)) {
            const result = await backend.delete(scope, AbortSignal.timeout(5000));
            if (result.status !== "ok" && result.status !== "missing") fail(result.status);
            if (await observedKey(backend, journal, entry)) fail("deletion-unconfirmed");
        }
        entry.status = "absent";
        await files.write(NAME, JSON.stringify(journal));
    }
    journal.state = "deleted";
    await files.write(NAME, JSON.stringify(journal));
}
