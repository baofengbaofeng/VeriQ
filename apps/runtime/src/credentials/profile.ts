/** 凭据档案把系统密钥生命周期、私有密文索引与业务消费者放在同一个排他事务中，密钥只留在内存及系统保险库；非秘密恢复日志绑定确切档案和旧新清单，不使用最新版本猜测或重新调用业务更新函数。 */
import { randomBytes, randomUUID, createHash, createHmac } from "node:crypto";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { requireStoppedHistory } from "../execution/stopped-history.ts";
import { LocalStore } from "../offline/store.ts";
import { validateSchema, type JsonValue } from "@veriq/contracts";
import type { VaultKeyBackend } from "./backend.ts";
import { openEnvelope, sealEnvelope, type EnvelopeBinding } from "./envelope.ts";
import { VaultFiles } from "./files.ts";
import {
    acquireDesktopProfileOwner,
    ownsDesktopProfile,
    type DesktopProfileOwner,
} from "./ownership.ts";
import type { SecretReference } from "./store.ts";
import type { DeviceConfig } from "../enrollment.ts";

/** 宿主显式提供已选择的有限密钥后端，配置文件不能指定可执行路径或任意插件；测试也通过同一个接口提供独立夹具，生产构造器不会检查环境变量或秘密内容来决定是否绕过系统服务。 */
export type CredentialOptions = { backend: VaultKeyBackend; desktopOwner?: DesktopProfileOwner };
/** 轮换候选沿用既有服务端幂等协议，旧设备与替换令牌必须一起经过认证加密；请求标识独立保存在当前私有索引以形成预期认证绑定，不从待解密载荷中自行选择恢复请求。 */
export type Rotation = {
    previous: DeviceConfig;
    clientRequestId: string;
    replacementToken: string;
};
type Reference = EnvelopeBinding["reference"];
type Entry = { file: string; purpose: EnvelopeBinding["purpose"]; reference?: Reference };
type Manifest = {
    version: 1;
    profileId: string;
    keyVersion: string;
    keyHash: string;
    state: "initializing" | "active";
    entries: Record<string, Entry>;
};
type Journal = {
    version: 1;
    profileId: string;
    keyVersion: string;
    phase: "preparing" | "prepared";
    previous: string;
    next: string;
    created: string[];
    retired: string[];
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const FILE = /^record-[0-9a-f-]{36}\.json$/;
const INDEX = "profile.json";
const JOURNAL = "transaction.json";
const STAGED = "profile-next.json";
const INITIALIZATION = "initialization.json";
type Initialization = {
    version: 1;
    profileId: string;
    state: "pending" | "active";
    previous: Array<{ keyVersion: string; keyHash: string; status: "pending" | "absent" }>;
    next: { keyVersion: string; keyHash: string };
};
const QUOTA = 1024 * 1024;
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
function fail(status: string): never {
    throw new Error(`VAULT_${status.replaceAll("-", "_").toUpperCase()}`);
}
function absent(): never {
    throw Object.assign(new Error("DEVICE_NOT_ENROLLED"), { code: "ENOENT" });
}
function parseManifest(wire: string): Manifest {
    let value: Manifest;
    try {
        value = JSON.parse(wire) as Manifest;
    } catch {
        return fail("profile-corrupt");
    }
    if (
        !value ||
        value.version !== 1 ||
        !UUID.test(value.profileId) ||
        !UUID.test(value.keyVersion) ||
        !HASH.test(value.keyHash) ||
        !["initializing", "active"].includes(value.state) ||
        !value.entries ||
        typeof value.entries !== "object" ||
        Array.isArray(value.entries) ||
        Object.keys(value).sort().join() !== "entries,keyHash,keyVersion,profileId,state,version"
    )
        fail("profile-corrupt");
    for (const [slot, entry] of Object.entries(value.entries)) {
        if (
            !entry ||
            !FILE.test(entry.file) ||
            !["business", "device", "rotation"].includes(entry.purpose) ||
            (entry.purpose === "business"
                ? Object.keys(entry).sort().join() !== "file,purpose" ||
                  businessSlot(businessReference(slot)) !== slot
                : !entry.reference ||
                  typeof entry.reference !== "object" ||
                  Object.keys(entry).sort().join() !== "file,purpose,reference" ||
                  slot !== entry.purpose)
        )
            fail("profile-corrupt");
    }
    if (value.state === "initializing" && Object.keys(value.entries).length)
        fail("profile-corrupt");
    return value;
}
/** 显式恢复日志只保存未激活版本的随机密钥校验值与精确退休结果，最多保留一百二十八个历史意图以限制损坏数据开销；旧新版本必须唯一且属于同一档案，日志不能自行引入业务条目、路径或系统凭据目标。 */
function parseInitialization(wire: string): Initialization {
    let value: Initialization;
    try {
        value = JSON.parse(wire) as Initialization;
    } catch {
        return fail("initialization-corrupt");
    }
    if (
        !value ||
        value.version !== 1 ||
        !UUID.test(value.profileId) ||
        !["pending", "active"].includes(value.state) ||
        Object.keys(value).sort().join() !== "next,previous,profileId,state,version" ||
        !value.next ||
        Object.keys(value.next).sort().join() !== "keyHash,keyVersion" ||
        !UUID.test(value.next.keyVersion) ||
        !HASH.test(value.next.keyHash) ||
        !Array.isArray(value.previous) ||
        value.previous.length < 1 ||
        value.previous.length > 128 ||
        value.previous.some(
            (entry) =>
                !entry ||
                Object.keys(entry).sort().join() !== "keyHash,keyVersion,status" ||
                !UUID.test(entry.keyVersion) ||
                !HASH.test(entry.keyHash) ||
                !["pending", "absent"].includes(entry.status) ||
                (value.state === "active" && entry.status !== "absent"),
        ) ||
        new Set([...value.previous.map((entry) => entry.keyVersion), value.next.keyVersion])
            .size !==
            value.previous.length + 1
    )
        fail("initialization-corrupt");
    return value;
}

function businessSlot(ref: SecretReference) {
    return JSON.stringify([ref.issuerId, ref.workspaceId, ref.secretRef, ref.versionId]);
}
function businessReference(slot: string): SecretReference {
    let tuple: unknown;
    try {
        tuple = JSON.parse(slot);
    } catch {
        return fail("profile-corrupt");
    }
    if (
        !Array.isArray(tuple) ||
        tuple.length !== 4 ||
        !tuple.every((value) => typeof value === "string")
    )
        fail("profile-corrupt");
    return {
        issuerId: tuple[0]!,
        workspaceId: tuple[1]!,
        secretRef: tuple[2]!,
        versionId: tuple[3]!,
    };
}
function binding(
    manifest: Manifest,
    entry: { purpose: Entry["purpose"]; reference: Reference | undefined },
): EnvelopeBinding {
    return {
        profileId: manifest.profileId,
        keyVersion: manifest.keyVersion,
        ...entry,
    } as EnvelopeBinding;
}

/** 凭据事务在清单认证上下文下访问三种固定用途，业务引用由调用方给定而设备代际由当前私有清单提供；新密文先写入不可变名称并完整解密读回，成功后才允许原子发布索引，不让未提交文件成为有效数据。 */
export class CredentialTransaction {
    constructor(
        private files: VaultFiles,
        private manifest: Manifest,
        private key: Buffer,
    ) {}
    private async read(slot: string, expected?: SecretReference): Promise<JsonValue | undefined> {
        const entry = this.manifest.entries[slot];
        if (!entry) return undefined;
        const wire = await this.files.read(entry.file);
        if (wire === undefined) fail("record-missing");
        return openEnvelope(
            wire,
            binding(
                this.manifest,
                expected
                    ? { purpose: "business", reference: expected }
                    : { purpose: entry.purpose, reference: entry.reference },
            ),
            this.key,
        );
    }
    private async commit(
        next: Manifest,
        payloads: Array<{ entry: Entry; reference: Reference; value: JsonValue }>,
    ) {
        const before = JSON.stringify(this.manifest);
        const after = JSON.stringify(next);
        const retained = new Set(Object.values(next.entries).map((entry) => entry.file));
        const journal: Journal = {
            version: 1,
            profileId: next.profileId,
            keyVersion: next.keyVersion,
            phase: "preparing",
            previous: digest(before),
            next: digest(after),
            created: payloads.map(({ entry }) => entry.file),
            retired: Object.values(this.manifest.entries)
                .map((entry) => entry.file)
                .filter((file) => !retained.has(file)),
        };
        if (Buffer.byteLength(after) > 2 * QUOTA) fail("index-limit");
        await this.files.write(JOURNAL, JSON.stringify(journal));
        for (const { entry, reference, value } of payloads) {
            const expected = binding(next, { purpose: entry.purpose, reference });
            const wire = sealEnvelope(value, expected, this.key);
            await this.files.write(entry.file, wire);
            const actual = await this.files.read(entry.file);
            if (actual !== wire) fail("readback-failed");
            openEnvelope(actual, expected, this.key);
        }
        await this.files.write(STAGED, after);
        if ((await this.files.read(STAGED)) !== after) fail("readback-failed");
        journal.phase = "prepared";
        await this.files.write(JOURNAL, JSON.stringify(journal));
        await this.files.write(INDEX, after);
        this.manifest = next;
        await recover(this.files, next, this.key);
    }
    private async put(
        slot: string,
        purpose: Entry["purpose"],
        reference: Reference,
        value: JsonValue,
    ) {
        const entry: Entry = {
            file: `record-${randomUUID()}.json`,
            purpose,
            ...(purpose === "business" ? {} : { reference }),
        };
        const next = structuredClone(this.manifest);
        next.entries[slot] = entry;
        await this.commit(next, [{ entry, reference, value }]);
    }

    /** 业务查找必须使用外层授权过的完整四元引用，当前索引只决定要读取的有限文件名称，不能以密文自报的版本补全引用；真实条目缺失才产生本地凭据缺失，密钥和认证错误继续上抛。 */
    async resolve(ref: SecretReference): Promise<JsonValue> {
        const value = await this.read(businessSlot(ref), ref);
        if (value === undefined) throw new Error("LOCAL_CREDENTIAL_MISSING");
        return value;
    }
    /** 写入容量按原四元组键值表的完整明文 JSON 字节计算，逐条解密核验旧值后再加入替换值；信封开销不计入业务额度，同时每个实际文件仍受独立两兆字节硬上限保护。 */
    async set(ref: SecretReference, value: JsonValue): Promise<void> {
        const aggregate: Record<string, JsonValue> = Object.create(null) as Record<
            string,
            JsonValue
        >;
        for (const [slot, entry] of Object.entries(this.manifest.entries)) {
            if (entry.purpose === "business")
                aggregate[slot] = (await this.read(slot, businessReference(slot)))!;
        }
        aggregate[businessSlot(ref)] = value;
        if (Buffer.byteLength(JSON.stringify(aggregate)) > QUOTA)
            throw new Error("CONFIGURATION_LIMIT");
        await this.put(businessSlot(ref), "business", ref, value);
    }
    /** 删除指定业务引用或整个业务集合只发布删减后的索引并退休这些文件，不删除其他用途或主密钥；跨文件清理中断保留确切日志，恢复不会把已经移除的条目重新激活。 */
    async removeBusiness(ref?: SecretReference): Promise<void> {
        const next = structuredClone(this.manifest);
        for (const [slot, entry] of Object.entries(next.entries)) {
            if (entry.purpose === "business" && (!ref || slot === businessSlot(ref)))
                delete next.entries[slot];
        }
        await this.commit(next, []);
    }
    /** 设备读取以当前私有索引保存的登记主体和稳定代际为预期上下文，缺失保持原公开接口的 ENOENT；结果仍须由 DeviceStore 执行既有控制源和服务端 DTO 校验，不能仅凭解密成功授权联网。 */
    async device(): Promise<DeviceConfig> {
        return ((await this.read("device")) ?? absent()) as DeviceConfig;
    }
    /** 首次设备登记创建新的本地代际，后续轮换必须保留相同服务端主体及代际；容量保持原六万五千五百三十六字节且 create-only 在同一事务锁中检查，不允许覆盖已注册设备。 */
    async saveDevice(value: DeviceConfig, createOnly: boolean): Promise<void> {
        if (Buffer.byteLength(JSON.stringify(value)) > 65536)
            throw new Error("CONFIGURATION_LIMIT");
        const prior = this.manifest.entries.device;
        if (prior && createOnly) throw new Error("ALREADY_ENROLLED");
        const reference = {
            server: value.server,
            workspaceId: value.workspaceId,
            runnerId: value.runnerId,
            generation:
                prior?.reference && "generation" in prior.reference
                    ? prior.reference.generation
                    : randomUUID(),
        };
        if (prior) {
            const old = prior.reference as typeof reference;
            if (
                old.server !== reference.server ||
                old.workspaceId !== reference.workspaceId ||
                old.runnerId !== reference.runnerId
            )
                throw new Error("DEVICE_PRINCIPAL_CHANGED");
        }
        await this.put("device", "device", reference, value as JsonValue);
    }
    /** 读取待恢复轮换时使用索引固定的原请求标识进行认证，候选不存在才允许 DeviceStore 生成新请求；损坏或不确定提交必须先解决，不能用新令牌覆盖未知服务端已经接受的轮换。 */
    async rotation(): Promise<Rotation | undefined> {
        return (await this.read("rotation")) as Rotation | undefined;
    }
    /** 轮换日志保存完整旧凭据和替换令牌的密文，同时绑定当前登记代际与固定请求标识；只有当前设备存在且业务体未超过原容量才发布，确保网络调用开始之前可以按同一候选恢复。 */
    async saveRotation(value: Rotation): Promise<void> {
        const current = this.manifest.entries.device;
        if (!current) absent();
        if (Buffer.byteLength(JSON.stringify(value)) > 65536)
            throw new Error("CONFIGURATION_LIMIT");
        await this.put(
            "rotation",
            "rotation",
            { ...current.reference, clientRequestId: value.clientRequestId } as Reference,
            value as JsonValue,
        );
    }
    /** 迁移仅由持有停止所有权的档案入口调用，源文件校验值使用主密钥 HMAC 而非可离线猜测密码的普通摘要；全部用途写入同一新清单并读回后才标记可退休，恢复只处理固定三个旧文件名。 */
    async migrate(root: VaultFiles): Promise<void> {
        const names = ["local-secrets.json", "device.json", "rotation.json"] as const;
        type Migration = {
            version: 1;
            profileId: string;
            keyVersion: string;
            phase: "copying" | "verified";
            sources: Partial<Record<(typeof names)[number], string>>;
        };
        const existing = await this.files.read("migration.json");
        let journal: Migration;
        if (existing === undefined) {
            const sources: Migration["sources"] = {};
            for (const name of names) {
                const wire = await root.read(name);
                if (wire !== undefined)
                    sources[name] = createHmac("sha256", this.key).update(wire).digest("hex");
            }
            journal = {
                version: 1,
                profileId: this.manifest.profileId,
                keyVersion: this.manifest.keyVersion,
                phase: "copying",
                sources,
            };
            await this.files.write("migration.json", JSON.stringify(journal));
        } else {
            try {
                journal = JSON.parse(existing) as Migration;
            } catch {
                return fail("migration-corrupt");
            }
            if (
                !journal ||
                journal.version !== 1 ||
                journal.profileId !== this.manifest.profileId ||
                journal.keyVersion !== this.manifest.keyVersion ||
                !["copying", "verified"].includes(journal.phase) ||
                !journal.sources ||
                typeof journal.sources !== "object" ||
                Object.entries(journal.sources).some(
                    ([name, mac]) =>
                        !names.includes(name as (typeof names)[number]) ||
                        typeof mac !== "string" ||
                        !HASH.test(mac),
                )
            )
                fail("migration-corrupt");
        }
        const source: Partial<Record<(typeof names)[number], string>> = {};
        for (const name of names) {
            const wire = await root.read(name);
            if (wire === undefined) {
                if (journal.phase === "copying" && journal.sources[name])
                    fail("migration-source-changed");
            } else {
                if (
                    createHmac("sha256", this.key).update(wire).digest("hex") !==
                    journal.sources[name]
                )
                    fail("migration-source-changed");
                source[name] = wire;
            }
        }
        if (journal.phase === "copying") {
            const next = structuredClone(this.manifest);
            next.entries = {};
            const payloads: Array<{ entry: Entry; reference: Reference; value: JsonValue }> = [];
            const add = (
                slot: string,
                purpose: Entry["purpose"],
                reference: Reference,
                value: JsonValue,
            ) => {
                const entry: Entry = {
                    file: `record-${randomUUID()}.json`,
                    purpose,
                    ...(purpose === "business" ? {} : { reference }),
                };
                next.entries[slot] = entry;
                payloads.push({ entry, reference, value });
            };
            if (source["local-secrets.json"] !== undefined) {
                const wire = source["local-secrets.json"]!;
                if (Buffer.byteLength(wire) > QUOTA) throw new Error("CONFIGURATION_LIMIT");
                let values: Record<string, JsonValue>;
                try {
                    values = JSON.parse(wire) as Record<string, JsonValue>;
                } catch {
                    return fail("migration-source-corrupt");
                }
                if (
                    !values ||
                    typeof values !== "object" ||
                    Array.isArray(values) ||
                    validateSchema("JsonValue", values).length
                )
                    fail("migration-source-corrupt");
                for (const [slot, value] of Object.entries(values))
                    add(slot, "business", businessReference(slot), value);
            }
            let deviceReference: Reference | undefined;
            if (source["device.json"] !== undefined) {
                const wire = source["device.json"]!;
                if (Buffer.byteLength(wire) > 65536) throw new Error("CONFIGURATION_LIMIT");
                let value: DeviceConfig;
                try {
                    value = JSON.parse(wire) as DeviceConfig;
                } catch {
                    return fail("migration-source-corrupt");
                }
                const { server, ...receipt } = value;
                if (validateSchema("DeviceCredentialsDTO", receipt).length)
                    fail("migration-source-corrupt");
                const old = this.manifest.entries.device?.reference;
                deviceReference = {
                    server,
                    workspaceId: value.workspaceId,
                    runnerId: value.runnerId,
                    generation: old && "generation" in old ? old.generation : randomUUID(),
                };
                add("device", "device", deviceReference, value as JsonValue);
            }
            if (source["rotation.json"] !== undefined) {
                const wire = source["rotation.json"]!;
                if (Buffer.byteLength(wire) > 65536 || !deviceReference)
                    fail("migration-source-corrupt");
                let value: Rotation;
                try {
                    value = JSON.parse(wire) as Rotation;
                } catch {
                    return fail("migration-source-corrupt");
                }
                if (
                    !value.previous ||
                    !UUID.test(value.clientRequestId) ||
                    typeof value.replacementToken !== "string" ||
                    value.previous.server !== (deviceReference as { server: string }).server ||
                    value.previous.workspaceId !==
                        (deviceReference as { workspaceId: string }).workspaceId ||
                    value.previous.runnerId !== (deviceReference as { runnerId: string }).runnerId
                )
                    fail("migration-source-corrupt");
                add(
                    "rotation",
                    "rotation",
                    { ...deviceReference, clientRequestId: value.clientRequestId } as Reference,
                    value as JsonValue,
                );
            }
            await this.commit(next, payloads);
            journal.phase = "verified";
            await this.files.write("migration.json", JSON.stringify(journal));
        }
        for (const [slot, entry] of Object.entries(this.manifest.entries))
            await this.read(
                slot,
                entry.purpose === "business" ? businessReference(slot) : undefined,
            );
        for (const name of names) if (journal.sources[name]) await root.remove(name);
        await this.files.remove("migration.json");
    }
    /** 设备删除先在同一新清单中同时退休轮换和设备，单独完成轮换只删候选；业务密文及系统主密钥保持可用，删除日志失败不会被误报为整个档案已经完全清理或物理擦除。 */
    async removeDevice(rotationOnly = false): Promise<void> {
        const next = structuredClone(this.manifest);
        delete next.entries.rotation;
        if (!rotationOnly) {
            if (!next.entries.device) absent();
            delete next.entries.device;
        }
        await this.commit(next, []);
    }
}

/** 恢复只接受绑定当前档案和确切旧新清单摘要的有限日志，准备阶段只清理尚未发布的新文件，已准备阶段则完成同一确定提交；不执行业务回调、不生成替代密钥，也不对任意路径实施清理。 */
async function recover(files: VaultFiles, manifest: Manifest, key: Buffer): Promise<Manifest> {
    const wire = await files.read(JOURNAL);
    if (wire === undefined) return manifest;
    let journal: Journal;
    try {
        journal = JSON.parse(wire) as Journal;
    } catch {
        return fail("journal-corrupt");
    }
    if (
        !journal ||
        journal.version !== 1 ||
        journal.profileId !== manifest.profileId ||
        journal.keyVersion !== manifest.keyVersion ||
        !["preparing", "prepared"].includes(journal.phase) ||
        !HASH.test(journal.previous) ||
        !HASH.test(journal.next) ||
        !Array.isArray(journal.created) ||
        !Array.isArray(journal.retired) ||
        ![...journal.created, ...journal.retired].every(
            (name) => typeof name === "string" && FILE.test(name),
        )
    )
        fail("journal-corrupt");
    const currentHash = digest(JSON.stringify(manifest));
    if (journal.phase === "preparing") {
        if (currentHash !== journal.previous) fail("journal-conflict");
        const live = new Set(Object.values(manifest.entries).map((entry) => entry.file));
        if (journal.created.some((name) => live.has(name))) fail("journal-conflict");
        for (const name of journal.created) await files.remove(name);
    } else {
        const staged = await files.read(STAGED);
        if (
            !staged ||
            digest(staged) !== journal.next ||
            ![journal.previous, journal.next].includes(currentHash)
        )
            fail("journal-conflict");
        const next = parseManifest(staged);
        if (
            next.profileId !== manifest.profileId ||
            next.keyVersion !== manifest.keyVersion ||
            next.keyHash !== manifest.keyHash
        )
            fail("journal-conflict");
        for (const [slot, entry] of Object.entries(next.entries)) {
            if (!journal.created.includes(entry.file)) continue;
            const encrypted = await files.read(entry.file);
            if (encrypted === undefined) fail("record-missing");
            openEnvelope(
                encrypted,
                binding(next, {
                    purpose: entry.purpose,
                    reference:
                        entry.purpose === "business" ? businessReference(slot) : entry.reference,
                }),
                key,
            );
        }
        if (currentHash === journal.previous) await files.write(INDEX, staged);
        manifest = next;
        const live = new Set(Object.values(manifest.entries).map((entry) => entry.file));
        if (journal.retired.some((name) => live.has(name))) fail("journal-conflict");
        for (const name of journal.retired) await files.remove(name);
    }
    await files.remove(JOURNAL);
    await files.remove(STAGED);
    return manifest;
}

/** 档案对象由宿主显式后端构造，所有消费者共用同一目录合作锁，允许在一次持锁回调中依次提交轮换候选和正式设备；回调只调用一次，失败后仅释放资源，不自动重复网络请求或密钥写入。 */
export class CredentialProfile {
    constructor(
        readonly directory: string,
        private options: CredentialOptions,
    ) {}

    /** 显式迁移在整个读取、密文发布、完整核验与明文退休期间持有 Agent 停止所有权和同一档案事务锁；正在运行的 Agent 会使获取失败，不能把一次性状态检查视为持续停止证明或绕过已有运行者。 */
    async migrate(): Promise<void> {
        await this.withStoppedProfile((root) =>
            this.withTransaction((tx) => tx.migrate(root), true),
        );
    }

    /** 用户显式请求才允许恢复确实空的未激活初始化，原版本必须精确读为缺失才能建立新随机版本；同一档案身份保持，旧意图及逐版本缺失证明持续保存在非秘密日志，活动凭据、残留密文和未知状态一律不能被重置。 */
    async recoverInitialization(): Promise<void> {
        await this.withStoppedProfile(() =>
            this.withLockedFiles(async (_root, files) => {
                const wire = await files.read(INDEX);
                if (wire === undefined) fail("initialization-not-pending");
                let manifest = parseManifest(wire);
                const logged = await files.read(INITIALIZATION);
                let journal = logged === undefined ? undefined : parseInitialization(logged);
                if (manifest.state === "active" && journal?.state !== "pending")
                    fail("initialization-not-pending");
                if (
                    Object.keys(manifest.entries).length ||
                    !(await files.containsOnly([INDEX, INITIALIZATION]))
                )
                    fail("initialization-data-present");
                if (journal) {
                    if (journal.profileId !== manifest.profileId) fail("initialization-conflict");
                    const previous = journal.previous.at(-1)!;
                    if (
                        manifest.keyVersion === previous.keyVersion &&
                        manifest.keyHash === previous.keyHash &&
                        manifest.state === "initializing"
                    ) {
                        manifest = { ...manifest, ...journal.next };
                        await files.write(INDEX, JSON.stringify(manifest));
                    } else if (
                        manifest.keyVersion !== journal.next.keyVersion ||
                        manifest.keyHash !== journal.next.keyHash
                    ) {
                        fail("initialization-conflict");
                    }
                }
                const readKey = async () => {
                    const result = await this.options.backend.get(
                        { profileId: manifest.profileId, keyVersion: manifest.keyVersion },
                        AbortSignal.timeout(5000),
                    );
                    if (result.status === "missing") return false;
                    if (result.status !== "ok") fail(result.status);
                    try {
                        if (result.key.length !== 32 || digest(result.key) !== manifest.keyHash)
                            fail("key-conflict");
                    } finally {
                        result.key.fill(0);
                    }
                    return true;
                };
                /** 旧版本只能在显式记录的档案范围内退休，先核对随机密钥校验值再调用精确 delete；修改失败或删除后无法确认缺失都保留 pending，下一次仅按原意图核验，不把不确定返回伪装为密钥已清理。 */
                const retire = async () => {
                    if (!journal) return;
                    for (const previous of journal.previous) {
                        if (previous.status === "absent") continue;
                        const scope = {
                            profileId: journal.profileId,
                            keyVersion: previous.keyVersion,
                        };
                        const result = await this.options.backend.get(
                            scope,
                            AbortSignal.timeout(5000),
                        );
                        if (result.status === "ok") {
                            try {
                                if (
                                    result.key.length !== 32 ||
                                    digest(result.key) !== previous.keyHash
                                )
                                    fail("key-conflict");
                            } finally {
                                result.key.fill(0);
                            }
                            const removed = await this.options.backend.delete(
                                scope,
                                AbortSignal.timeout(5000),
                            );
                            if (!["ok", "missing"].includes(removed.status)) fail(removed.status);
                            const after = await this.options.backend.get(
                                scope,
                                AbortSignal.timeout(5000),
                            );
                            if (after.status === "ok") {
                                after.key.fill(0);
                                fail("mutation-unconfirmed");
                            }
                            if (after.status !== "missing") fail(after.status);
                        } else if (result.status !== "missing") fail(result.status);
                        previous.status = "absent";
                        await files.write(INITIALIZATION, JSON.stringify(journal));
                    }
                };
                let present = await readKey();
                if (!present) {
                    if (manifest.state !== "initializing") fail("key-missing");
                    await retire();
                    if ((journal?.previous.length ?? 0) >= 128)
                        fail("initialization-recovery-limit");
                    const key = randomBytes(32);
                    try {
                        const next = { keyVersion: randomUUID(), keyHash: digest(key) };
                        journal = {
                            version: 1,
                            profileId: manifest.profileId,
                            state: "pending",
                            previous: [
                                ...(journal?.previous ?? []),
                                {
                                    keyVersion: manifest.keyVersion,
                                    keyHash: manifest.keyHash,
                                    status: "pending",
                                },
                            ],
                            next,
                        };
                        await files.write(INITIALIZATION, JSON.stringify(journal));
                        manifest = { ...manifest, ...next };
                        await files.write(INDEX, JSON.stringify(manifest));
                        const result = await this.options.backend.set(
                            { profileId: manifest.profileId, keyVersion: manifest.keyVersion },
                            key,
                            AbortSignal.timeout(5000),
                        );
                        if (result.status !== "ok") fail(result.status);
                        present = await readKey();
                        if (!present) fail("key-missing");
                    } finally {
                        key.fill(0);
                    }
                }
                manifest.state = "active";
                await files.write(INDEX, JSON.stringify(manifest));
                await retire();
                if (journal) {
                    journal.state = "active";
                    await files.write(INITIALIZATION, JSON.stringify(journal));
                }
            }),
        );
    }

    /** 迁移与空初始化恢复共享同一持续停止边界，执行记录、在线所有权和离线 SQLite 占用全部通过后才调用私有操作；资源始终按事务、数据库、Agent 和桌面所有权逆序释放，失败不会授权强杀或清理未知执行。 */
    private async withStoppedProfile<T>(run: (root: VaultFiles) => Promise<T>): Promise<T> {
        const root = await VaultFiles.acquire(this.directory);
        let owner: VaultFiles | undefined;
        let release: (() => Promise<void>) | undefined;
        let desktopRelease: (() => Promise<void>) | undefined;
        let idle: (() => void) | undefined;
        let executions: LocalStore | undefined;
        try {
            owner = await VaultFiles.acquire(join(this.directory, "agent-owner"));
            if (this.options.desktopOwner) {
                if (!ownsDesktopProfile(this.options.desktopOwner, this.directory))
                    fail("owner-invalid");
            } else {
                desktopRelease = (
                    await acquireDesktopProfileOwner(this.directory).catch(
                        (error: NodeJS.ErrnoException) => {
                            if (error.code === "ELOCKED")
                                throw new Error("AGENT_RUNNING_STOP_FIRST");
                            throw error;
                        },
                    )
                ).release;
            }
            release = await lockfile
                .lock(join(this.directory, "agent-owner"), { realpath: false, retries: 0 })
                .catch(() => {
                    throw new Error("AGENT_RUNNING_STOP_FIRST");
                });
            await requireStoppedHistory(join(this.directory, "agent"));
            executions = await LocalStore.open(join(this.directory, "offline"));
            idle = executions.holdIdle();
            return await run(root);
        } finally {
            try {
                try {
                    idle?.();
                } finally {
                    executions?.close();
                }
            } finally {
                try {
                    await release?.();
                } finally {
                    try {
                        await desktopRelease?.();
                    } finally {
                        try {
                            await owner?.close();
                        } finally {
                            await root.close();
                        }
                    }
                }
            }
        }
    }

    /** 消费者事务只使用明确的密钥后端和当前档案，普通调用不能开启迁移或读回遗留明文；实现通过私有入口复用单锁资源管理，业务回调不会因后端失败、未知提交或恢复日志而自动重复执行。 */
    async transaction<T>(run: (transaction: CredentialTransaction) => Promise<T>): Promise<T> {
        return this.withTransaction(run, false);
    }

    /** 事务入口先取得私有目录和既有设备锁，再恢复有限文件日志并读取确切系统密钥；新档案先持久化初始化意图及随机密钥校验值，未知 OS 写入只保留恢复事实，后续仅按原版本读回而不覆盖。 */
    private async withTransaction<T>(
        run: (transaction: CredentialTransaction) => Promise<T>,
        migrating: boolean,
    ): Promise<T> {
        return this.withLockedFiles(async (root, files) => {
            let key: Buffer | undefined;
            try {
                if (!migrating) {
                    if ((await files.read("migration.json")) !== undefined)
                        fail("migration-required");
                    for (const legacy of ["local-secrets.json", "device.json", "rotation.json"])
                        if ((await root.read(legacy)) !== undefined) fail("migration-required");
                }
                const initialization = await files.read(INITIALIZATION);
                const recovery =
                    initialization === undefined ? undefined : parseInitialization(initialization);
                if (recovery?.state === "pending") fail("initialization-recovery-required");
                const wire = await files.read(INDEX);
                let manifest: Manifest;
                if (wire === undefined) {
                    if (!(await files.empty())) fail("profile-missing");
                    key = randomBytes(32);
                    manifest = {
                        version: 1,
                        profileId: randomUUID(),
                        keyVersion: randomUUID(),
                        keyHash: digest(key),
                        state: "initializing",
                        entries: {},
                    };
                    await files.write(INDEX, JSON.stringify(manifest));
                    const result = await this.options.backend.set(
                        { profileId: manifest.profileId, keyVersion: manifest.keyVersion },
                        key,
                        AbortSignal.timeout(5000),
                    );
                    if (result.status !== "ok") fail(result.status);
                } else manifest = parseManifest(wire);
                if (
                    recovery &&
                    (manifest.profileId !== recovery.profileId ||
                        manifest.keyVersion !== recovery.next.keyVersion ||
                        manifest.keyHash !== recovery.next.keyHash ||
                        manifest.state !== "active")
                )
                    fail("initialization-conflict");
                const result = await this.options.backend.get(
                    { profileId: manifest.profileId, keyVersion: manifest.keyVersion },
                    AbortSignal.timeout(5000),
                );
                if (result.status !== "ok")
                    fail(result.status === "missing" ? "key-missing" : result.status);
                key?.fill(0);
                key = result.key;
                if (key.length !== 32 || digest(key) !== manifest.keyHash) fail("key-conflict");
                if (manifest.state === "initializing") {
                    manifest.state = "active";
                    await files.write(INDEX, JSON.stringify(manifest));
                }
                manifest = await recover(files, manifest, key);
                return await run(new CredentialTransaction(files, manifest, key));
            } finally {
                key?.fill(0);
            }
        });
    }

    /** 凭据事务与显式初始化恢复只复用同一个档案锁和有限文件会话，不嵌套取得设备锁；所有异常在资源释放后继续传播，调用方没有自动重放业务函数、系统写入或未知文件发布的机会。 */
    private async withLockedFiles<T>(
        run: (root: VaultFiles, files: VaultFiles) => Promise<T>,
    ): Promise<T> {
        const root = await VaultFiles.acquire(this.directory);
        let release: (() => Promise<void>) | undefined;
        let files: VaultFiles | undefined;
        try {
            release = await lockfile.lock(this.directory, {
                realpath: false,
                retries: 0,
                ...(process.platform === "win32"
                    ? { lockfilePath: join(this.directory, ".device.lock") }
                    : {}),
            });
            files = await VaultFiles.acquire(join(this.directory, "vault"));
            return await run(root, files);
        } finally {
            try {
                await files?.close();
            } finally {
                try {
                    await release?.();
                } finally {
                    await root.close();
                }
            }
        }
    }
}
