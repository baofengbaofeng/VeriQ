/** 凭据封装仅使用标准 AES256GCM 与契约规范字节保护内存中的 JSON 载荷，调用方必须独立提供预期身份；本模块不读取档案、不保存主密钥，也不将算法单测等同于系统保险库验收。 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { canonicalBytes, validateSchema, type JsonValue } from "@veriq/contracts";
import type { SecretReference } from "./store.ts";
import type { VaultKeyScope } from "./backend.ts";

const PAYLOAD_LIMIT = 1024 * 1024;
const ENVELOPE_LIMIT = 2 * PAYLOAD_LIMIT;
const ALGORITHM = "AES-256-GCM";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,159}$/;

/** 设备绑定保留现有控制源、工作区和执行器主体，并增加由持久化层维护的凭据代际标识；该代际不得从未验证密文自动取得，轮换候选另外绑定原有幂等请求标识以维持崩溃恢复关系。 */
type DeviceReference = {
    server: string;
    workspaceId: string;
    runnerId: string;
    generation: string;
};

/** 信封绑定由读取方独立提供预期档案、密钥版本及用途，业务包含完整四元引用，设备和轮换保留明确主体与代际；这种区分禁止把文件名、最新版本或密文自报身份当作解密授权依据。 */
export type EnvelopeBinding = VaultKeyScope &
    (
        | { purpose: "business"; reference: SecretReference }
        | { purpose: "device"; reference: DeviceReference }
        | { purpose: "rotation"; reference: DeviceReference & { clientRequestId: string } }
    );

/** 封装错误只暴露固定英文代码而不携带载荷、密钥、原始加密错误或其原因链，认证失败与缺失保持不同语义；调用方可直接映射这些代码，但不能据此自动生成替代密钥或重试提交。 */
export class VaultError extends Error {
    constructor(
        readonly code:
            | "VAULT_INVALID_KEY"
            | "VAULT_INVALID_BINDING"
            | "VAULT_INVALID_PAYLOAD"
            | "VAULT_PAYLOAD_LIMIT"
            | "VAULT_ENVELOPE_LIMIT"
            | "VAULT_INVALID_ENVELOPE"
            | "VAULT_BINDING_MISMATCH"
            | "VAULT_AUTHENTICATION_FAILED"
            | "VAULT_ENCRYPTION_FAILED",
    ) {
        super(code);
        this.name = "VaultError";
    }
}

function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exact(value: Record<string, unknown>, names: string[]) {
    return (
        Object.keys(value).length === names.length &&
        names.every((name) => Object.hasOwn(value, name))
    );
}

function identifier(value: unknown) {
    return typeof value === "string" && UUID.test(value);
}

/** 认证上下文先检查有限字段与主体形状再交给既有规范序列化器，拒绝缺项、额外字段和无效控制源；生成规范字节同时取得独立快照，避免调用方随后修改原始对象改变已经选定的认证输入。 */
function checkedBinding(value: unknown): EnvelopeBinding {
    try {
        if (
            !record(value) ||
            !exact(value, ["profileId", "keyVersion", "purpose", "reference"]) ||
            !identifier(value.profileId) ||
            !identifier(value.keyVersion) ||
            !record(value.reference)
        )
            throw new Error();
        const ref = value.reference;
        if (value.purpose === "business") {
            if (
                !exact(ref, ["issuerId", "workspaceId", "secretRef", "versionId"]) ||
                typeof ref.issuerId !== "string" ||
                !NAME.test(ref.issuerId) ||
                typeof ref.secretRef !== "string" ||
                !NAME.test(ref.secretRef) ||
                !identifier(ref.workspaceId) ||
                !identifier(ref.versionId)
            )
                throw new Error();
        } else if (value.purpose === "device" || value.purpose === "rotation") {
            const fields = ["server", "workspaceId", "runnerId", "generation"];
            if (value.purpose === "rotation") fields.push("clientRequestId");
            if (
                !exact(ref, fields) ||
                !identifier(ref.workspaceId) ||
                !identifier(ref.runnerId) ||
                !identifier(ref.generation) ||
                (value.purpose === "rotation" && !identifier(ref.clientRequestId)) ||
                typeof ref.server !== "string" ||
                ref.server.length > 2048
            )
                throw new Error();
            const url = new URL(ref.server);
            if (
                url.origin !== ref.server ||
                url.username ||
                url.password ||
                !(
                    url.protocol === "https:" ||
                    (url.protocol === "http:" &&
                        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
                )
            )
                throw new Error();
        } else throw new Error();
        return JSON.parse(Buffer.from(canonicalBytes(value)).toString("utf8")) as EnvelopeBinding;
    } catch {
        throw new VaultError("VAULT_INVALID_BINDING");
    }
}

function checkedKey(key: Buffer) {
    if (!Buffer.isBuffer(key) || key.length !== 32) throw new VaultError("VAULT_INVALID_KEY");
}

function metadata(binding: EnvelopeBinding) {
    return { version: 1, algorithm: ALGORITHM, binding };
}

/** 载荷先按已有契约拒绝不可移植的值，再使用共享规范字节计算真实 UTF8 大小，不能按字符数截断或静默丢弃字段；错误只保留固定分类，不转发包含业务值的验证器详细诊断。 */
function payload(value: unknown): Buffer {
    let bytes: Buffer;
    try {
        if (validateSchema("JsonValue", value).length) throw new Error();
        bytes = Buffer.from(canonicalBytes(value));
    } catch {
        throw new VaultError("VAULT_INVALID_PAYLOAD");
    }
    if (bytes.length > PAYLOAD_LIMIT) throw new VaultError("VAULT_PAYLOAD_LIMIT");
    return bytes;
}

/** 每次封装使用系统随机源产生新的十二字节随机数，以完整规范元数据作为附加认证数据并固定十六字节标签；返回值只有公开绑定与密文，不包含密钥，大小允许现有一兆字节载荷的编码开销。 */
export function sealEnvelope(value: JsonValue, expected: EnvelopeBinding, key: Buffer): string {
    checkedKey(key);
    const binding = checkedBinding(expected);
    const bytes = payload(value);
    try {
        const iv = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
        cipher.setAAD(canonicalBytes(metadata(binding)));
        const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
        const wire = JSON.stringify({
            ...metadata(binding),
            iv: iv.toString("base64url"),
            tag: cipher.getAuthTag().toString("base64url"),
            ciphertext: ciphertext.toString("base64url"),
        });
        if (Buffer.byteLength(wire) > ENVELOPE_LIMIT) throw new VaultError("VAULT_ENVELOPE_LIMIT");
        return wire;
    } catch (error) {
        if (error instanceof VaultError) throw error;
        throw new VaultError("VAULT_ENCRYPTION_FAILED");
    }
}

/** 外部编码必须是无填充的规范 base64url，解码后重新编码检查剩余位及固定长度，防止宽松的系统解码器接受多种文本表示；密文大小另由调用方在进入解密之前执行统一上限检查。 */
function decode(value: unknown, length?: number): Buffer {
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value))
        throw new VaultError("VAULT_INVALID_ENVELOPE");
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value || (length !== undefined && bytes.length !== length))
        throw new VaultError("VAULT_INVALID_ENVELOPE");
    return bytes;
}

/** 解封先限制输入字节并验证完整有限结构，再将文件绑定与调用方预期逐字节比较，最后执行认证解密；任何篡改或错误密钥均不返回部分明文，也不将认证失败误认为缺少凭据。 */
export function openEnvelope(wire: string, expected: EnvelopeBinding, key: Buffer): JsonValue {
    checkedKey(key);
    const binding = checkedBinding(expected);
    if (typeof wire !== "string") throw new VaultError("VAULT_INVALID_ENVELOPE");
    if (Buffer.byteLength(wire) > ENVELOPE_LIMIT) throw new VaultError("VAULT_ENVELOPE_LIMIT");
    let envelope: Record<string, unknown>;
    let actual: EnvelopeBinding;
    try {
        const parsed: unknown = JSON.parse(wire);
        if (
            !record(parsed) ||
            !exact(parsed, ["version", "algorithm", "binding", "iv", "tag", "ciphertext"]) ||
            parsed.version !== 1 ||
            parsed.algorithm !== ALGORITHM
        )
            throw new Error();
        envelope = parsed;
        actual = checkedBinding(parsed.binding);
    } catch {
        throw new VaultError("VAULT_INVALID_ENVELOPE");
    }
    if (!Buffer.from(canonicalBytes(actual)).equals(Buffer.from(canonicalBytes(binding))))
        throw new VaultError("VAULT_BINDING_MISMATCH");
    const iv = decode(envelope.iv, 12);
    const tag = decode(envelope.tag, 16);
    const ciphertext = decode(envelope.ciphertext);
    if (ciphertext.length > PAYLOAD_LIMIT) throw new VaultError("VAULT_PAYLOAD_LIMIT");
    let plaintext: Buffer;
    try {
        const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
        decipher.setAAD(canonicalBytes(metadata(binding)));
        decipher.setAuthTag(tag);
        plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch {
        throw new VaultError("VAULT_AUTHENTICATION_FAILED");
    }
    try {
        const value: unknown = JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(plaintext),
        );
        payload(value);
        return value as JsonValue;
    } catch {
        throw new VaultError("VAULT_INVALID_PAYLOAD");
    }
}
