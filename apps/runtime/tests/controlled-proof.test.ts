import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";

const attemptId = "11111111-1111-1111-1111-111111111111";
const binding = {
    version: 1,
    attemptId,
    ownerGeneration: 7,
    commandSlot: "22222222-2222-2222-2222-222222222222",
    nonce: "a".repeat(64),
};
const cliBinding = { ...binding, commandSlot: "33333333-3333-3333-3333-333333333333" };
const identity = {
    version: 1,
    platform: "darwin",
    attemptId,
    uid: 501,
    kind: "TEST",
    ownerGeneration: 7,
    nonce: binding.nonce,
    commandBinding: binding,
    cliBinding,
};
const summary = (bytes: Buffer, count: number) => ({
    bytes: bytes.length,
    count,
    sha256: createHash("sha256").update(bytes).digest("hex"),
});
const journal = () => ({
    ...structuredClone(identity),
    state: "STOPPED",
    outerPlanned: true,
    browserPlanned: true,
    cancellationAuthorized: false,
    browserStopAuthorized: true,
    outerPid: 101,
    chromePid: 102,
});
const proof = () => ({
    ...structuredClone(identity),
    state: "CONTROLLED_STOPPED",
    scope: "CONTROLLED_WORKER_BROWSER",
    outer: { pid: 101, code: 0, signal: null, observed: true },
    chrome: { pid: 102, code: 0, signal: null, observed: true },
    journals: {
        commands: summary(Buffer.from("commands"), 3),
        cli: summary(Buffer.from("cli"), 2),
    },
});

/**
 * 此处只测试有限私有证明的纯格式边界，手工身份与退出事实不会伪装成操作系统观察；缺少实现时明确断言公开验证能力缺失，畸
 * 形输入不得通过私有状态字符串取得受控停止信任。
 */
async function implementation() {
    const module = await import("../src/execution/darwin-proof.ts").catch((error) => {
        if (error.code === "ERR_MODULE_NOT_FOUND") return {};
        throw error;
    });
    assert.ok("validateControlledPair" in module, "controlled proof validator must be implemented");
    assert.ok("verifyControlledJournals" in module, "held journal validator must be implemented");
    return module;
}

/**
 * 有效配对只表达本平台、同一代际与两份固定绑定的已提交证明，不能接受任一孤立成员或未提交状态；替换这些身份或加入排空字
 * 段应使验证失败，而不是回退到裸 PID 的存在性。
 */
test("controlled proof requires exact committed identity and platform pair", async () => {
    const { validateControlledPair } = await implementation();
    const expected = { attemptId, uid: 501 };
    assert.equal(validateControlledPair(journal(), proof(), expected), true);
    for (const field of [
        "attemptId",
        "uid",
        "kind",
        "ownerGeneration",
        "nonce",
        "commandBinding",
        "cliBinding",
        "outerPid",
        "chromePid",
    ]) {
        const changed = journal() as Record<string, unknown>;
        changed[field] = field === "uid" || field.endsWith("Pid") || field === "ownerGeneration" ? 999 : "mismatch";
        assert.equal(validateControlledPair(changed, proof(), expected), false, field);
    }
    for (const changed of [
        undefined,
        null,
        {},
        { ...journal(), state: "RUNNING" },
        { ...journal(), platform: "linux" },
        { ...journal(), extra: true },
        { ...journal(), ownerGeneration: 0 },
        { ...journal(), browserStopAuthorized: false },
    ]) {
        assert.equal(validateControlledPair(changed, proof(), expected), false);
    }
    for (const changed of [
        undefined,
        null,
        {},
        { ...proof(), state: "DRAINED" },
        { ...proof(), scope: "FULL_DESCENDANT_TREE" },
        { ...proof(), workerPid: 101 },
        { ...proof(), platform: "linux" },
        { ...proof(), endpoint: "SECRET" },
        { ...proof(), outer: { pid: 101, code: null, signal: "SIGTERM", observed: true } },
        { ...proof(), outer: { pid: 101, code: 73, signal: null, observed: true } },
        { ...proof(), chrome: null },
    ]) {
        assert.equal(validateControlledPair(journal(), changed, expected), false);
    }
    assert.equal(validateControlledPair(journal(), proof(), { attemptId, uid: 502 }), false);
});

/**
 * 日志摘要必须保持有界计数与摘要格式，最大直接对象集合不能膨胀进六万五千字节的证明；未计划浏览器的验证和清理必须显式保
 * 持空浏览器事实，取消码只接受持久授权同代记录。
 */
test("controlled proof bounds roster and distinguishes planned absence and authorized cancellation", async () => {
    const { validateControlledPair } = await implementation();
    const expected = { attemptId, uid: 501 };
    for (const kind of ["VALIDATE", "CLEANUP"]) {
        const record = {
            ...journal(),
            kind,
            browserPlanned: false,
            browserStopAuthorized: false,
        } as Record<string, unknown>;
        delete record.chromePid;
        const value = {
            ...proof(),
            kind,
            chrome: null,
            journals: {
                commands: summary(Buffer.from("commands"), 2),
                cli: summary(Buffer.alloc(0), 0),
            },
        };
        assert.equal(validateControlledPair(record, value, expected), true);
        assert.equal(validateControlledPair(record, { ...value, chrome: proof().chrome }, expected), false);
    }
    const cancelled = { ...proof(), outer: { ...proof().outer, code: 130 } };
    assert.equal(validateControlledPair(journal(), cancelled, expected), false);
    assert.equal(validateControlledPair({ ...journal(), cancellationAuthorized: true }, cancelled, expected), true);
    for (const invalid of [
        { bytes: 1048577, count: 3, sha256: "a".repeat(64) },
        { bytes: 1, count: 4, sha256: "a".repeat(64) },
        { bytes: 1, count: 3, sha256: "x".repeat(64) },
        { bytes: 1, count: 3, sha256: "a".repeat(64), objects: [] },
    ]) {
        assert.equal(
            validateControlledPair(
                journal(),
                { ...proof(), journals: { ...proof().journals, commands: invalid } },
                expected,
            ),
            false,
        );
    }
    const emptyPrefix = {
        ...proof(),
        journals: {
            commands: summary(Buffer.from("sealed-empty-prefix"), 0),
            cli: summary(Buffer.alloc(0), 0),
        },
    };
    assert.equal(validateControlledPair(journal(), emptyPrefix, expected), false);
    assert.equal(validateControlledPair({ ...journal(), cancellationAuthorized: true }, emptyPrefix, expected), true);
});

/**
 * 手工字节遵循唯一 C1 帧协议而不调用生产日志生成器，故删掉封存或放宽角色顺序会被实际验证结果捕获；这些结构测试明确不提
 * 供 CLI、outer 或浏览器真实退出的替代证据。
 */
function frames(expected: typeof binding, codes: { code: number | null; signal: string | null }[]) {
    const result: object[] = [{ ...expected, seq: 0, type: "OBSERVER_READY" }];
    for (const [index, exit] of codes.entries()) {
        const slot = index + 1;
        result.push({ version: 1, seq: result.length, type: "INTENT", slot });
        result.push({ version: 1, seq: result.length, type: "SPAWNED", slot, pid: 200 + slot });
        result.push({
            version: 1,
            seq: result.length,
            type: "EXITED",
            slot,
            exitCode: exit.code,
            signal: exit.signal,
        });
    }
    result.push({ version: 1, seq: result.length, type: "SEAL" });
    return Buffer.from(result.map((value) => JSON.stringify(value) + "\n").join(""));
}

test("both final journals require fixed prefix, complete seals and CLI exit authorization", async () => {
    const { verifyControlledJournals } = await implementation();
    const commands = frames(binding, [
        { code: 0, signal: null },
        { code: 0, signal: null },
        { code: 1, signal: null },
    ]);
    const cli = frames(cliBinding, [{ code: 0, signal: null }]);
    assert.deepEqual(verifyControlledJournals(journal(), commands, cli), {
        commands: summary(commands, 3),
        cli: summary(cli, 1),
    });
    for (const [a, b] of [
        [commands.subarray(0, commands.lastIndexOf("{")), cli],
        [commands, Buffer.alloc(0)],
        [commands, commands],
        [
            frames(binding, [
                { code: 1, signal: null },
                { code: 0, signal: null },
            ]),
            Buffer.alloc(0),
        ],
        [
            frames(binding, [
                { code: 0, signal: null },
                { code: 0, signal: null },
                { code: 130, signal: null },
            ]),
            cli,
        ],
    ]) {
        assert.throws(() => verifyControlledJournals(journal(), a!, b!), /CONTROLLED/);
    }
    const direct = frames(binding, [{ code: null, signal: "SIGINT" }]);
    assert.throws(() => verifyControlledJournals(journal(), direct, Buffer.alloc(0)), /CONTROLLED/);
    assert.deepEqual(
        verifyControlledJournals({ ...journal(), cancellationAuthorized: true }, direct, Buffer.alloc(0)),
        { commands: summary(direct, 1), cli: summary(Buffer.alloc(0), 0) },
    );
    const empty = frames(binding, []);
    assert.deepEqual(verifyControlledJournals({ ...journal(), cancellationAuthorized: true }, empty, Buffer.alloc(0)), {
        commands: summary(empty, 0),
        cli: summary(Buffer.alloc(0), 0),
    });
});

/**
 * 共享记录读取器也服务 attempts 目录，因此 Darwin 停止确认必须另核 processes 角色白名单；普通 JSON、未知后缀和 staging
 * 不能混入合法选中证明，而其他已识别的活动过程成员仍保持独立。
 */
test("controlled process directory rejects bare JSON roles and preserves recognized active members", async () => {
    const module = await implementation();
    assert.ok("isControlledProcessMember" in module, "process-role validator must be implemented");
    for (const name of [
        `${attemptId}.process.json`,
        `${attemptId}.controlled.json`,
        `${attemptId}.drained.json`,
        "other-active.process.json",
    ])
        assert.equal(module.isControlledProcessMember(name), true, name);
    for (const name of [
        "unexpected.json",
        `${attemptId}.json`,
        `${attemptId}.process.json.tmp`,
        ".stage",
        "nested/member.process.json",
    ])
        assert.equal(module.isControlledProcessMember(name), false, name);
});

/**
 * 私有过程和证明彼此匹配仍不能代替 Claim 的业务任务身份，无浏览器的验证或清理不能冒充 TEST；本纯测试只验证身份边，真实
 * Darwin 历史读取继续由原生组件 suite 独立覆盖。
 */
test("controlled history binds Claim kind, generation and Attempt to the process identity", async () => {
    const module = await implementation();
    assert.ok("matchesControlledClaim" in module, "Claim/process identity validator must be implemented");
    const claim = { attemptId, jobKind: "TEST", fencingToken: 7 };
    assert.equal(module.matchesControlledClaim(journal(), claim), true);
    for (const changed of [
        { ...claim, jobKind: "VALIDATE" },
        { ...claim, jobKind: "CLEANUP" },
        { ...claim, fencingToken: 8 },
        { ...claim, attemptId: "99999999-9999-9999-9999-999999999999" },
        {},
    ])
        assert.equal(module.matchesControlledClaim(journal(), changed), false);
});
