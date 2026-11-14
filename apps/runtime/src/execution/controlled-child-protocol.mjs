import { fstatSync } from "node:fs";

/** VeriQ 的 CLI 日志只存储受控对象的结构事实，本模块同时约束激活身份、私有普通描述符和最终封存状态，避免父子两侧对同一字节流采用不同的成功判据。 */
export const LIMITS = Object.freeze({ frameBytes: 4096, fileBytes: 1024 * 1024, records: 8192, objects: 1024 });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const noncePattern = /^[0-9a-f]{64}$/;
const identityKeys = ["version", "attemptId", "ownerGeneration", "commandSlot", "nonce"];
const positive = (value) => Number.isSafeInteger(value) && value > 0;

/** 所有拒绝只暴露固定英文错误码而不包含原始行、路径或环境值，调用层可据此保守处理失败且不会把身份之外的秘密从恶意输入复制到日志或报告中。 */
function reject() {
    throw new Error("CONTROLLED_CHILD_PROTOCOL_INVALID");
}

/** 精确字段集合既拒绝未知字段也拒绝数组与空值，键顺序仍允许由生产者选择；重复字段的字节歧义由后续 stringify 往返检查独立拒绝而非依赖 JSON.parse。 */
function exact(value, keys) {
    if (!value || Array.isArray(value) || typeof value !== "object") reject();
    const actual = Object.keys(value);
    if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) reject();
}

/** 身份只接受明确的小写 UUID、正安全代际和三十二字节随机量的十六进制表示；这个验证不声称 nonce 的来源可信，随机生成与可信调用路径由未来父层负责。 */
function identity(value) {
    if (value.version !== 1 || !uuid.test(value.attemptId) || typeof value.attemptId !== "string"
        || !uuid.test(value.commandSlot) || typeof value.commandSlot !== "string"
        || !positive(value.ownerGeneration) || typeof value.nonce !== "string" || !noncePattern.test(value.nonce)) reject();
}

/** 父侧期望绑定不携带任何可复用的 PID 或描述符编号，验证时复制有限字段形成独立快照，因此调用者随后修改输入对象不会改变已注册观察所绑定的 Attempt。 */
export function validateBinding(value) {
    exact(value, identityKeys);
    identity(value);
    return Object.fromEntries(identityKeys.map((key) => [key, value[key]]));
}

/** 激活标记中的 fd 是子 CLI 的显式 stdio 槽位而非父进程原编号，严格往返要求消除重复键与数字歧义，使错误激活只能进入专用失败退出而不能悄悄退化为无观察执行。 */
export function parseActivation(raw) {
    if (typeof raw !== "string" || Buffer.byteLength(raw) > LIMITS.frameBytes) reject();
    const marker = JSON.parse(raw);
    exact(marker, [...identityKeys, "fd"]);
    identity(marker);
    if (!Number.isSafeInteger(marker.fd) || marker.fd < 4 || JSON.stringify(marker) !== raw) reject();
    const binding = Object.fromEntries(identityKeys.map((key) => [key, marker[key]]));
    return { binding, fd: marker.fd };
}

/** 描述符校验只针对已经打开的同一文件对象，不按字符串重新打开也不假造 Windows ACL；普通文件的所有者和精确权限可核实后才允许写入或读取，目录持久条件留给 B。 */
export function inspectJournalFd(fd, requireEmpty = false) {
    if (!Number.isSafeInteger(fd) || fd < 0 || typeof process.getuid !== "function" || process.platform === "win32") {
        throw new Error("CONTROLLED_CHILD_FD_UNSUPPORTED");
    }
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.uid !== BigInt(process.getuid()) || (stat.mode & 0o7777n) !== 0o600n
        || stat.size > BigInt(LIMITS.fileBytes) || (requireEmpty && stat.size !== 0n)) reject();
    return stat;
}

/** 最终字节流只能采用严格 UTF8 与单 LF 分帧，首条 READY 后连续序号并以唯一 SEAL 收尾；普通文件暂时 EOF 不是结束事实，这个纯验证器本身不对外授予生命周期成功。 */
export function validateJournal(bytes, expectedBinding) {
    const binding = validateBinding(expectedBinding);
    if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > LIMITS.fileBytes || bytes.at(-1) !== 10) reject();
    const objects = [];
    const states = new Map();
    let offset = 0;
    let sequence = 0;
    let sealed = false;
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    for (let end = 0; end < bytes.length; end++) {
        if (bytes[end] !== 10) continue;
        if (end === offset || end - offset + 1 > LIMITS.frameBytes || sequence >= LIMITS.records || sealed) reject();
        const line = decoder.decode(bytes.subarray(offset, end));
        const frame = JSON.parse(line);
        if (JSON.stringify(frame) !== line || frame.version !== 1 || frame.seq !== sequence) reject();
        offset = end + 1;
        sequence++;
        if (sequence === 1) {
            exact(frame, [...identityKeys, "seq", "type"]);
            if (frame.type !== "OBSERVER_READY" || identityKeys.some((key) => frame[key] !== binding[key])) reject();
            continue;
        }
        if (frame.type === "SEAL") {
            exact(frame, ["version", "seq", "type"]);
            if ([...states.values()].some((state) => state !== "EXITED")) reject();
            sealed = true;
            continue;
        }
        if (!positive(frame.slot)) reject();
        if (frame.type === "INTENT") {
            exact(frame, ["version", "seq", "type", "slot"]);
            if (frame.slot !== objects.length + 1 || objects.length >= LIMITS.objects) reject();
            objects.push({ slot: frame.slot });
        } else if (frame.type === "SPAWNED") {
            exact(frame, ["version", "seq", "type", "slot", "pid"]);
            if (states.get(frame.slot) !== "INTENT" || !positive(frame.pid)) reject();
            objects[frame.slot - 1].pid = frame.pid;
        } else if (frame.type === "EXITED") {
            exact(frame, ["version", "seq", "type", "slot", "exitCode", "signal"]);
            if (states.get(frame.slot) !== "SPAWNED") reject();
            const code = Number.isSafeInteger(frame.exitCode) && frame.exitCode >= 0;
            const signal = typeof frame.signal === "string" && /^SIG[A-Z0-9]+$/.test(frame.signal);
            if (!((code && frame.signal === null) || (frame.exitCode === null && signal))) reject();
            Object.assign(objects[frame.slot - 1], { exitCode: frame.exitCode, signal: frame.signal });
        } else reject();
        states.set(frame.slot, frame.type);
    }
    if (!sealed) reject();
    return { objects };
}
