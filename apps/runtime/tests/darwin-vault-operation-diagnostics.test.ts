/** 这些可移植回归只驱动真实异步结算与共用诊断编解码，不启动 Mac 控制器或模拟系统授权；如果结算丢失原错误、遗漏清理、接受私有字段或覆盖首个观察边界，以下行为断言必须直接失败。 */
import test from "node:test";
import assert from "node:assert/strict";
import * as vault from "./fixtures/darwin-vault.ts";

/** 动态读取新增 API 使旧源码在红灯阶段产生明确缺失断言，而不会在模块加载时提前退出；真实实现就绪后所有测试仍调用同一个夹具函数，不使用替身结算器或复制生产算法。 */
const settle = (...args: Parameters<typeof vault.settleDarwinCase>) => {
    assert.equal(typeof vault.settleDarwinCase, "function");
    return vault.settleDarwinCase(...args);
};
const frame = (value: unknown) => Buffer.from(JSON.stringify(value) + "\n");
const collect = (summary: unknown) =>
    vault.collectDarwinDiagnostics([
        Buffer.from("# VERIQ_D1_DIAGNOSTICS " + JSON.stringify(summary) + "\n"),
    ]);

/** 四个组合分别检查原对象身份及执行顺序，清理只由结算器调用一次且密钥必须先覆盖；观察器在 body 结束后已经得到状态，因此后续清理不能反向掩盖原来的断言失败。 */
for (const bodyFails of [false, true]) {
    for (const cleanupFails of [false, true]) {
        test(`settlement body=${bodyFails} cleanup=${cleanupFails}`, async () => {
            const primary = new Error("body");
            const secondary = new Error("cleanup");
            const key = Buffer.alloc(32, 17);
            const order: string[] = [];
            const observations: vault.DarwinCaseFacts[] = [];
            let failed = false;
            let thrown: unknown;
            try {
                await settle(
                    async () => {
                        await Promise.resolve();
                        order.push("body");
                        if (bodyFails) throw primary;
                    },
                    [
                        () => {
                            order.push("wipe");
                            key.fill(0);
                        },
                    ],
                    async () => {
                        assert.equal(
                            observations.at(-1)?.bodyStatus,
                            bodyFails ? "FAILED" : "PASSED",
                        );
                        order.push("cleanup");
                        assert.ok(key.every((byte) => byte === 0));
                        if (cleanupFails) throw secondary;
                    },
                    (facts) => {
                        observations.push(facts);
                    },
                );
            } catch (error) {
                failed = true;
                thrown = error;
            }
            assert.deepEqual(order, ["body", "wipe", "cleanup"]);
            assert.equal(failed, bodyFails || cleanupFails);
            if (failed) assert.equal(thrown, bodyFails ? primary : secondary);
            assert.deepEqual(observations.at(-1), {
                bodyStatus: bodyFails ? "FAILED" : "PASSED",
                cleanupStatus: cleanupFails ? "FAILED" : "PASSED",
                wipeStatus: "PASSED",
                primary: bodyFails ? "BODY" : cleanupFails ? "CLEANUP" : "NONE",
                secondary: bodyFails && cleanupFails ? "CLEANUP" : "NONE",
            });
        });
    }
}

/** JavaScript 允许抛出非真值，结算状态必须由独立标志决定而不能靠异常对象真值判断；这些探针保留 undefined、null、false 的身份并确认失败之后仍执行覆盖与清理。 */
for (const primary of [undefined, null, false]) {
    test(`settlement retains falsy thrown ${String(primary)}`, async () => {
        let caught = false;
        let wiped = 0;
        let cleaned = 0;
        try {
            await settle(
                async () => {
                    throw primary;
                },
                [
                    () => {
                        wiped++;
                    },
                ],
                async () => {
                    cleaned++;
                },
            );
        } catch (error) {
            caught = true;
            assert.equal(error, primary);
        }
        assert.equal(caught, true);
        assert.equal(wiped, 1);
        assert.equal(cleaned, 1);
    });
}

/** 覆盖回调失败不能中止剩余密钥或清理，而观察器及异常对象上的恶意访问器都不能影响原结果；测试只验证有限来源分类，不允许读取异常文字、构造器或堆栈来生成诊断。 */
for (const bodyFails of [false, true]) {
    test(`wipe failure with observer isolation body=${bodyFails}`, async () => {
        const hostile = Object.defineProperties(
            {},
            {
                message: {
                    get() {
                        throw new Error("getter");
                    },
                },
                constructor: {
                    get() {
                        throw new Error("getter");
                    },
                },
            },
        );
        const wipeError = new Error("wipe");
        const order: string[] = [];
        const observations: vault.DarwinCaseFacts[] = [];
        await assert.rejects(
            settle(
                async () => {
                    if (bodyFails) throw hostile;
                },
                [
                    () => {
                        order.push("first");
                        throw wipeError;
                    },
                    () => {
                        order.push("second");
                    },
                ],
                async () => {
                    order.push("cleanup");
                    throw new Error("cleanup");
                },
                (facts) => {
                    observations.push(facts);
                    throw hostile;
                },
            ),
            (error) => error === (bodyFails ? hostile : wipeError),
        );
        assert.deepEqual(order, ["first", "second", "cleanup"]);
        assert.equal(observations.at(-1)?.wipeStatus, "FAILED");
        assert.equal(observations.at(-1)?.secondary, bodyFails ? "WIPE_AND_CLEANUP" : "CLEANUP");
    });
}

/** 失败上下文只接收有限操作与已返回的 helper 事实，后续退出或清理拒绝不能替换首个观察；有效领域拒绝仍然是合法 V1 回复，只有断言失败才以明确的 body 边界来源引用它。 */
test("first operation retains observed exit2 empty response across cleanup", () => {
    const filter = vault.createDarwinDiagnosticFilter();
    filter.operation("run", "GET");
    filter.helper(2, "EMPTY", false);
    filter.fail("CLOSED");
    filter.operation("cleanup", "UNKNOWN");
    filter.fail("REFUSED");
    const summary = filter.finish(1);
    assert.deepEqual(summary.operationContext, {
        operation: "run",
        verb: "GET",
        ordinal: 1,
        category: "HELPER",
        helperExit: 2,
        shape: "EMPTY",
        provenance: "CONTROLLER",
    });
    assert.equal(collect(summary).rejected, false);
});
test("valid domain refusal is only a body assertion boundary", () => {
    const filter = vault.createDarwinDiagnosticFilter();
    filter.operation("run", "SET");
    filter.helper(0, "PARSED_V1", true);
    filter.nodeCase({
        bodyStatus: "FAILED",
        cleanupStatus: "NOT_RECORDED",
        wipeStatus: "NOT_RECORDED",
        primary: "BODY",
        secondary: "NONE",
    });
    filter.operation("cleanup", "UNKNOWN");
    filter.fail("REFUSED");
    const summary = filter.finish(1);
    assert.equal(summary.operationContext?.provenance, "BODY_BOUNDARY");
    assert.equal(summary.operationContext?.category, "BODY");
    assert.equal(summary.operationContext?.helperExit, 0);
    assert.equal(summary.operationContext?.shape, "PARSED_V1");
});

/** 非法参数与观察器访问器只降低完整性而不泄漏输入或向业务抛错，命令计数耗尽后继续运行调用者代码；这些测试覆盖实际共享过滤器，而非由测试拼装另一个相似的导出实现。 */
test("unknown operations getters and ordinal exhaustion stop metadata safely", () => {
    const filter = vault.createDarwinDiagnosticFilter();
    filter.operation("SECRET_CANARY", "SECRET_CANARY");
    filter.helper(256, "SECRET_CANARY", false);
    const getterFilter = vault.createDarwinDiagnosticFilter();
    let getterCalls = 0;
    const hostile = Object.defineProperty(
        {
            cleanupStatus: "NOT_RECORDED",
            wipeStatus: "NOT_RECORDED",
            primary: "NONE",
            secondary: "NONE",
        },
        "bodyStatus",
        {
            enumerable: true,
            get() {
                getterCalls++;
                throw new Error("getter");
            },
        },
    );
    assert.doesNotThrow(() => getterFilter.nodeCase(hostile as vault.DarwinCaseFacts));
    assert.equal(getterCalls, 1);
    assert.equal(getterFilter.finish(1).rejected, true);
    const summary = filter.finish(1);
    assert.equal(summary.rejected, true);
    assert.equal(summary.incomplete, true);
    assert.ok(!JSON.stringify(summary).includes("SECRET_CANARY"));
    const exhausted = vault.createDarwinDiagnosticFilter();
    for (let ordinal = 0; ordinal < 65536; ordinal++) exhausted.operation("lock", "UNKNOWN");
    exhausted.fail("REFUSED");
    const end = exhausted.finish(1);
    assert.equal(end.incomplete, true);
    assert.equal(end.rejected, true);
    assert.equal(end.operationContext, undefined);
});

/** 旧概要继续有效且未知字段必须在真实收集器中拒绝，有限 Node 来源与原生记录保持独立；每个畸形输入均通过公开 JSON 路径送入验证器，避免只测试某个私有校验函数而遗漏导出通路。 */
test("strict optional case and operation schema roundtrips and rejects private facts", () => {
    const filter = vault.createDarwinDiagnosticFilter();
    filter.push(frame({ schemaVersion: 1, stage: "CREATE_REPLY", state: "passed" }));
    filter.operation("run", "DELETE");
    filter.helper(2, "EMPTY", false);
    filter.nodeCase({
        bodyStatus: "FAILED",
        cleanupStatus: "FAILED",
        wipeStatus: "PASSED",
        primary: "BODY",
        secondary: "CLEANUP",
    });
    filter.close(null, "SIGKILL");
    const summary = filter.finish(1);
    const result = collect(summary);
    assert.deepEqual(result.fixtures, [summary]);
    assert.equal(result.rejected, false);
    for (const mutation of [
        { nodeCase: { ...summary.nodeCase, path: "SECRET_CANARY" } },
        { nodeCase: { ...summary.nodeCase, bodyStatus: "ok" } },
        { nodeCase: { ...summary.nodeCase, bodyStatus: "PASSED" } },
        { operationContext: { ...summary.operationContext, ordinal: "1" } },
        { operationContext: { ...summary.operationContext, ordinal: 0 } },
        { operationContext: { ...summary.operationContext, ordinal: 65536 } },
        { operationContext: { ...summary.operationContext, helperExit: 256 } },
        { operationContext: { ...summary.operationContext, helperExit: -1 } },
        { operationContext: { ...summary.operationContext, helperExit: "2" } },
        { operationContext: { ...summary.operationContext, helperExit: null } },
        { operationContext: { ...summary.operationContext, ordinal: 1.5 } },
        { operationContext: { ...summary.operationContext, verb: "get" } },
        { operationContext: { ...summary.operationContext, category: "SECRET_CANARY" } },
        { nodeCase: null },
        { nodeCase: { ...summary.nodeCase, secondary: "NONE" } },
        { nodeCase: { ...summary.nodeCase, wipeStatus: "NOT_RECORDED" } },
        { operationContext: { ...summary.operationContext, shape: "V1 secret" } },
        { operationContext: { ...summary.operationContext, operation: "SECRET_CANARY" } },
        { operationContext: { ...summary.operationContext, provenance: "NATIVE" } },
        { operationContext: { ...summary.operationContext, extra: true } },
        { config: "SECRET_CANARY" },
    ]) {
        const invalid = collect({ ...summary, ...mutation });
        assert.equal(invalid.rejected, true);
        assert.equal(invalid.fixtures.length, 0);
        assert.ok(!JSON.stringify(invalid).includes("SECRET_CANARY"));
    }
    const { nodeCase: _node, operationContext: _operation, ...legacy } = summary;
    assert.equal(collect(legacy).rejected, false);
});

/** 摘要使用既有五百一十二字节预留且两个正常五十四记录夹具仍在十六 KiB 总预算内；原生单行、单夹具和条数上限保持原值，超额输入必须保留拒绝或不完整标记而不能扩大预算。 */
test("worst finite summaries and healthy54 records retain original caps", () => {
    const summaries = [1, 2].map((ordinal) => {
        const filter = vault.createDarwinDiagnosticFilter();
        for (let index = 0; index < 54; index++)
            filter.push(
                frame({
                    schemaVersion: 1,
                    stage: "KEYCHAIN_STAT",
                    state: "passed",
                    regularFile: true,
                    ownerMatches: true,
                    privateMode: true,
                }),
            );
        for (let index = 0; index < 65535; index++) filter.operation("read-denial", "UNKNOWN");
        filter.fail("EXIT_UNCONFIRMED");
        filter.nodeCase({
            bodyStatus: "FAILED",
            cleanupStatus: "NOT_RECORDED",
            wipeStatus: "NOT_RECORDED",
            primary: "BODY",
            secondary: "NONE",
        });
        filter.close(null, "SIGSEGV");
        const summary = filter.finish(ordinal);
        const { records, ...header } = summary;
        assert.ok(Buffer.byteLength(JSON.stringify({ ...header, records: [] })) <= 512);
        assert.equal(records.length, 54);
        assert.ok(Buffer.byteLength(JSON.stringify(summary)) <= 8192);
        return summary;
    });
    const output = vault.collectDarwinDiagnostics(
        summaries.map((summary) =>
            Buffer.from("VERIQ_D1_DIAGNOSTICS " + JSON.stringify(summary) + "\n"),
        ),
    );
    assert.equal(output.fixtures.length, 2);
    assert.ok(Buffer.byteLength(JSON.stringify(output.fixtures)) <= 16384);
    const filter = vault.createDarwinDiagnosticFilter();
    for (let i = 0; i < 100; i++) filter.push(Buffer.from("x".repeat(513) + "\n"));
    const summary = filter.finish(1);
    assert.equal(summary.rejected, true);
    assert.equal(summary.incomplete, true);
});

/** 有效退出码的上下界与三个已有回复形状都经实际收集器往返，无法取得 helper 退出值的控制器拒绝保持未知；恶意超长行与第九十七条记录分别触发原上限，不能靠一个限额掩盖另一限额失效。 */
test("finite returned facts and independent line record fixture caps", () => {
    for (const code of [0, 2, 255, "UNKNOWN"]) {
        for (const shape of ["EMPTY", "PARSED_V1", "INVALID", "UNKNOWN"]) {
            const filter = vault.createDarwinDiagnosticFilter();
            filter.operation("run", "GET");
            filter.helper(code, shape, false);
            const summary = filter.finish(1);
            assert.equal(summary.operationContext?.helperExit, code);
            assert.equal(summary.operationContext?.shape, shape);
            assert.deepEqual(collect(summary).fixtures, [summary]);
        }
    }
    const refusal = vault.createDarwinDiagnosticFilter();
    refusal.operation("lock", "UNKNOWN");
    refusal.fail("REFUSED");
    assert.equal(refusal.finish(1).operationContext?.helperExit, "UNKNOWN");
    const limit = vault.createDarwinDiagnosticFilter();
    for (let index = 0; index < 97; index++)
        limit.push(frame({ schemaVersion: 1, stage: "RANDOM", state: "passed" }));
    const end = limit.finish(1);
    assert.equal(end.records.length, 96);
    assert.equal(end.incomplete, true);
    const oversized = { ...end, records: Array(97).fill(end.records[0]) };
    assert.equal(collect(oversized).rejected, true);
    assert.equal(collect({ ...end, operationContext: "x".repeat(8193) }).rejected, true);
});

/** helper 事实只能附属于实际 run 调用，其他控制器操作没有可借用的子进程退出值或回复形状；生产过滤器必须在导出之前拒绝这种矛盾组合，不能等工作流消费者发现之后才把它视作不完整。 */
test("producer rejects helper metadata on a non-helper operation", () => {
    const filter = vault.createDarwinDiagnosticFilter();
    filter.operation("lock", "UNKNOWN");
    filter.helper(2, "EMPTY", false);
    const summary = filter.finish(1);
    assert.equal(summary.rejected, true);
    assert.equal(summary.incomplete, true);
    assert.equal(summary.operationContext, undefined);
    assert.equal(collect(summary).rejected, false);
});

/** 工作流消费者必须独立拒绝非 run 操作夹带的 helper 退出值和回复形状，即使来源类别不是 HELPER 也不能借此通过；每个负例通过真实 JSON 收集器，合法未知上下文仍须往返保留，防止只加强生产端而留下消费端证据矛盾。 */
for (const operation of [
    "lock",
    "create",
    "race",
    "unlock",
    "seed",
    "remove",
    "unchanged",
    "read-denial",
    "cleanup",
    "UNKNOWN",
]) {
    test(`collector rejects helper facts for non-run ${operation}`, () => {
        const summary = vault.createDarwinDiagnosticFilter().finish(1);
        for (const category of ["REFUSED", "CLOSED", "BODY"]) {
            const context = {
                operation,
                verb: "UNKNOWN",
                ordinal: 1,
                category,
                helperExit: "UNKNOWN",
                shape: "UNKNOWN",
                provenance: category === "BODY" ? "BODY_BOUNDARY" : "CONTROLLER",
            };
            const candidate = {
                ...summary,
                operationContext: context,
                ...(category === "BODY"
                    ? {
                          nodeCase: {
                              bodyStatus: "FAILED",
                              cleanupStatus: "NOT_RECORDED",
                              wipeStatus: "NOT_RECORDED",
                              primary: "BODY",
                              secondary: "NONE",
                          },
                      }
                    : {}),
            };
            assert.deepEqual(collect(candidate).fixtures, [candidate]);
            for (const facts of [
                { helperExit: 2, shape: "EMPTY" },
                { helperExit: 2, shape: "UNKNOWN" },
                { helperExit: "UNKNOWN", shape: "EMPTY" },
                { helperExit: "UNKNOWN", shape: "PARSED_V1" },
                { helperExit: "UNKNOWN", shape: "INVALID" },
            ]) {
                const rejected = collect({
                    ...candidate,
                    operationContext: { ...context, ...facts },
                });
                assert.equal(rejected.rejected, true);
                assert.deepEqual(rejected.fixtures, []);
            }
        }
    });
}

/** 原生操作使用独立 OP 命名空间保存当前子阶段，不能借用 Node 的命令序号或 helper 退出字段；这些样本直接经过流过滤、概要导出与工作流收集，记录缺失只表示尚未观察而不推断任何系统调用结果。 */
const seedStages = [
    "input",
    "account",
    "key",
    "policy",
    "trusted",
    "array",
    "access",
    "extra-trusted",
    "extra-array",
    "acl",
    "auth",
    "add",
    "helper-start",
    "helper-collect",
    "helper-frame",
    "helper-decode",
    "read",
    "read-type",
    "value",
    "snapshot-match",
    "snapshot-shape",
    "snapshot-item",
    "snapshot-access",
    "snapshot-export",
    "cipher-open",
    "cipher-stat",
    "cipher-read",
];
const denialStages = [
    "baseline",
    "status-before",
    "helper-start",
    "event-before",
    "event-denied",
    "event-after",
    "helper-collect",
    "helper-frame",
    "status-after",
    "unchanged-guard",
    "read",
    "read-type",
    "snapshot-match",
    "snapshot-shape",
    "snapshot-item",
    "snapshot-access",
    "snapshot-export",
    "cipher-open",
    "cipher-stat",
    "cipher-read",
];
const nativeRecord = (
    nativeOperation = "seed",
    substage = "input",
    state = "failed",
    facts = {},
) => ({
    schemaVersion: 1,
    stage: "OP",
    state,
    nativeOperation,
    substage,
    ...facts,
});
const nativeSummary = (record: unknown) => {
    const filter = vault.createDarwinDiagnosticFilter();
    filter.push(frame(record));
    return filter.finish(1);
};
for (const [operation, stages] of [
    ["seed", seedStages],
    ["read-denial", denialStages],
] as const) {
    test(`native ${operation} substages roundtrip without inferred facts`, () => {
        for (const substage of stages) {
            const record = nativeRecord(operation, substage);
            const summary = nativeSummary(record);
            assert.equal(summary.rejected, false, substage);
            assert.deepEqual(summary.records, [record]);
            assert.deepEqual(collect(summary).fixtures, [summary]);
            assert.equal(summary.operationContext, undefined);
        }
    });
}
test("native entered-only remains incomplete with unknown terminal and helper", () => {
    const filter = vault.createDarwinDiagnosticFilter();
    filter.operation("read-denial", "UNKNOWN");
    filter.push(frame(nativeRecord("read-denial", "baseline", "entered")));
    filter.fail("REFUSED");
    filter.close(null, "SIGKILL");
    const summary = filter.finish(1);
    assert.equal(summary.rejected, false);
    assert.equal(summary.incomplete, true);
    assert.equal(summary.records.length, 1);
    assert.equal(summary.operationContext?.helperExit, "UNKNOWN");
    assert.equal(summary.operationContext?.shape, "UNKNOWN");
    assert.deepEqual(collect(summary).fixtures, [summary]);
});

/** 数值事实只能出现在实际执行对应调用的子阶段，布尔值只对应原谓词而事件分类不携带读到的字节；边界值和可缺失事实均通过真实收集器验证，确保消费者不会用类型强制转换或旧阶段状态补齐未知。 */
test("native optional returned facts accept exact finite boundaries", () => {
    const records = [
        ...[-2147483648, 0, 2147483647].map((osStatus) =>
            nativeRecord("seed", "trusted", "failed", { osStatus }),
        ),
        ...[0, 2147483647].map((errno) => nativeRecord("seed", "cipher-open", "failed", { errno })),
        ...[false, true].map((predicate) => nativeRecord("seed", "value", "failed", { predicate })),
        ...["poll-error", "read-error"].map((eventFailure) =>
            nativeRecord("read-denial", "event-denied", "failed", { eventFailure, errno: 5 }),
        ),
        ...["eof", "marker", "deadline"].map((eventFailure) =>
            nativeRecord("read-denial", "event-before", "failed", { eventFailure }),
        ),
        nativeRecord("seed", "done", "passed"),
        nativeRecord("read-denial", "done", "passed"),
    ];
    for (const record of records) {
        const summary = nativeSummary(record);
        assert.equal(summary.rejected, false);
        assert.deepEqual(summary.records, [record]);
        assert.deepEqual(collect(summary).fixtures, [summary]);
    }
});
test("native codec rejects incompatible states stages facts and coerced values", () => {
    const invalid = [
        nativeRecord("run"),
        nativeRecord("seed", "baseline"),
        nativeRecord("read-denial", "add"),
        nativeRecord("seed", "SECRET_CANARY"),
        nativeRecord("seed", "trusted", "entered"),
        nativeRecord("seed", "input", "passed"),
        nativeRecord("seed", "done", "failed"),
        nativeRecord("seed", "input", "entered", { predicate: true }),
        nativeRecord("seed", "done", "passed", { osStatus: 0 }),
        nativeRecord("seed", "trusted", "failed", { errno: 5 }),
        nativeRecord("seed", "cipher-open", "failed", { osStatus: 0 }),
        nativeRecord("seed", "value", "failed", { predicate: 1 }),
        nativeRecord("seed", "access", "failed", { predicate: true }),
        nativeRecord("seed", "trusted", "failed", { osStatus: "0" }),
        ...[null, 2147483648, -2147483649, 0.5].map((osStatus) =>
            nativeRecord("seed", "trusted", "failed", { osStatus }),
        ),
        ...[-1, 2147483648, "5", null].map((errno) =>
            nativeRecord("seed", "cipher-read", "failed", { errno }),
        ),
        nativeRecord("read-denial", "event-after", "failed", { eventFailure: "poll-error" }),
        nativeRecord("read-denial", "event-after", "failed", { eventFailure: "eof", errno: 0 }),
        nativeRecord("read-denial", "event-after", "failed", { errno: 5 }),
        nativeRecord("read-denial", "event-after", "failed", { eventFailure: "SECRET_CANARY" }),
        nativeRecord("seed", "helper-collect", "failed", { eventFailure: "deadline" }),
        nativeRecord("seed", "input", "failed", { created: true }),
        nativeRecord("seed", "input", "failed", { provenance: "CONTROLLER" }),
        nativeRecord("seed", "input", "failed", { helperExit: 2 }),
        { schemaVersion: 1, stage: "OP", state: "failed" },
        { ...nativeRecord(), stage: "KEYCHAIN_STAT" },
        { ...nativeRecord(), nativeOperation: null },
    ];
    const legacy = vault.createDarwinDiagnosticFilter().finish(1);
    for (const record of invalid) {
        const summary = nativeSummary(record);
        assert.equal(summary.rejected, true, JSON.stringify(record));
        assert.deepEqual(summary.records, []);
        const output = collect({ ...legacy, records: [record] });
        assert.equal(output.rejected, true, JSON.stringify(record));
        assert.deepEqual(output.fixtures, []);
        assert.ok(!JSON.stringify(output).includes("SECRET_CANARY"));
    }
});

/** 原生失败与 Node 正文和清理事实各自保留，最后一次成功操作不得借用前一阶段的状态码；这里用实际导出结果检查字段缺失与标准重建次序，同时确认诊断观察没有把合法领域拒绝转换成 helper 故障。 */
test("native facts remain separate from primary body secondary cleanup and canonical output", () => {
    const filter = vault.createDarwinDiagnosticFilter();
    filter.push(frame(nativeRecord("seed", "input", "entered")));
    const failed = nativeRecord("seed", "acl", "failed", { osStatus: -25293 });
    filter.push(frame(Object.fromEntries(Object.entries(failed).reverse())));
    filter.operation("seed", "UNKNOWN");
    filter.fail("REFUSED");
    filter.nodeCase({
        bodyStatus: "FAILED",
        cleanupStatus: "FAILED",
        wipeStatus: "PASSED",
        primary: "BODY",
        secondary: "CLEANUP",
    });
    filter.operation("cleanup", "UNKNOWN");
    filter.fail("CLOSED");
    filter.close(null, "SIGKILL");
    const summary = filter.finish(1);
    assert.equal(summary.rejected, false);
    assert.equal(summary.firstFailure, "REFUSED");
    assert.equal(summary.operationContext?.operation, "seed");
    assert.equal(summary.operationContext?.helperExit, "UNKNOWN");
    assert.equal(summary.nodeCase?.secondary, "CLEANUP");
    assert.deepEqual(collect(summary).fixtures, [summary]);
    assert.equal(JSON.stringify(summary.records[1]), JSON.stringify(failed));
    const fresh = nativeSummary(nativeRecord("seed", "helper-frame"));
    assert.equal(fresh.rejected, false);
    assert.deepEqual(Object.keys(fresh.records[0]!), [
        "schemaVersion",
        "stage",
        "state",
        "nativeOperation",
        "substage",
    ]);
});
test("native privacy rejects every unapproved field on both codec paths", () => {
    const legacy = vault.createDarwinDiagnosticFilter().finish(1);
    for (const key of [
        "config",
        "key",
        "value",
        "password",
        "uuid",
        "account",
        "principal",
        "path",
        "helperText",
        "error",
        "uid",
        "gid",
        "mode",
        "env",
        "frame",
    ]) {
        const record = nativeRecord("seed", "input", "failed", { [key]: "SECRET_CANARY" });
        const summary = nativeSummary(record);
        assert.equal(summary.rejected, true);
        assert.ok(!JSON.stringify(summary).includes("SECRET_CANARY"));
        const output = collect({ ...legacy, records: [record] });
        assert.equal(output.rejected, true);
        assert.ok(!JSON.stringify(output).includes("SECRET_CANARY"));
    }
});

/** 两个健康专用用例分别增加十六条和四条观察，旧创建清理记录与最大有限概要一起经过共享预算；这里只证明合成记录的编码上限，不代表 Objective-C++ 生产者或真实钥匙串操作已经在本机执行。 */
test("native legal worst case70 and case58 fit unchanged fixture and job caps", () => {
    const stages = [
        "STARTUP",
        "NO_UI",
        "RECEIVE",
        "CREATE_STATE",
        "LIVE_UID_LOGIN",
        "LIVE_SECURITY_SESSION",
        "LIVE_SESSION_BITS",
        "ATTEST_DISPOSABLE",
        "ATTEST_ACK",
        "ATTEST_UID",
        "ATTEST_LOGIN",
        "ATTEST_SESSION",
        "HELPER_REALPATH",
        "HELPER_NAME",
        "HELPER_STAT",
        "RANDOM",
        "DIRECTORY",
        "DIRECTORY_BIND",
        "KEYCHAIN_CREATE",
        "KEYCHAIN_PATH",
        "KEYCHAIN_BIND",
        "KEYCHAIN_MODE",
        "KEYCHAIN_IDENTITY",
        "KEYCHAIN_STAT",
        "CREATE_REPLY",
        "CLEANUP_DELETE",
        "CLEANUP_DIRECTORY",
    ];
    const summaries = [1, 2].map((fixture) => {
        const filter = vault.createDarwinDiagnosticFilter();
        let nativeBytes = 0;
        const push = (record: object) => {
            const bytes = frame(record);
            assert.ok(bytes.length <= 512);
            nativeBytes += bytes.length;
            filter.push(bytes);
        };
        for (const stage of stages) {
            push({
                schemaVersion: 1,
                stage,
                state: "entered",
                ...(["CREATE_STATE", "KEYCHAIN_CREATE", "CLEANUP_DELETE"].includes(stage)
                    ? { created: true, storeReferencePresent: true }
                    : {}),
            });
            push({
                schemaVersion: 1,
                stage,
                state: "passed",
                ...([
                    "NO_UI",
                    "LIVE_SECURITY_SESSION",
                    "RANDOM",
                    "KEYCHAIN_CREATE",
                    "KEYCHAIN_PATH",
                    "CLEANUP_DELETE",
                ].includes(stage)
                    ? { osStatus: 0 }
                    : {}),
                ...(["CREATE_STATE", "KEYCHAIN_CREATE", "CLEANUP_DELETE"].includes(stage)
                    ? { created: true, storeReferencePresent: true }
                    : {}),
                ...(stage === "KEYCHAIN_STAT"
                    ? { regularFile: true, ownerMatches: true, privateMode: true }
                    : {}),
            });
        }
        for (let index = 0; index < (fixture === 1 ? 8 : 2); index++) {
            const operation = fixture === 2 && index === 1 ? "read-denial" : "seed";
            push(nativeRecord(operation, operation === "seed" ? "input" : "baseline", "entered"));
            // 最长失败终态用于预算压力，即使真实健康终态只含 done，仍须在原预算内保留全部记录而不能依赖正常输出较短来掩盖失败时的截断或事实丢失。
            push(
                operation === "seed"
                    ? nativeRecord(operation, "snapshot-access", "failed", {
                          osStatus: -2147483648,
                      })
                    : nativeRecord(operation, "event-denied", "failed", {
                          eventFailure: "poll-error",
                          errno: 2147483647,
                      }),
            );
        }
        for (let index = 0; index < 65535; index++) filter.operation("read-denial", "UNKNOWN");
        filter.fail("EXIT_UNCONFIRMED");
        filter.nodeCase({
            bodyStatus: "FAILED",
            cleanupStatus: "FAILED",
            wipeStatus: "FAILED",
            primary: "BODY",
            secondary: "WIPE_AND_CLEANUP",
        });
        filter.close(null, "SIGSEGV");
        const summary = filter.finish(fixture);
        assert.equal(summary.rejected, false);
        assert.equal(summary.incomplete, false);
        assert.equal(summary.records.length, fixture === 1 ? 70 : 58);
        assert.ok(nativeBytes <= 8192);
        assert.ok(Buffer.byteLength(JSON.stringify(summary)) <= 8192);
        assert.deepEqual(collect(summary).fixtures, [summary]);
        console.log(
            JSON.stringify({
                fixture,
                nativeBytes,
                summaryBytes: Buffer.byteLength(JSON.stringify(summary)),
                records: summary.records.length,
            }),
        );
        return summary;
    });
    const output = vault.collectDarwinDiagnostics(
        summaries.map((summary) =>
            Buffer.from("VERIQ_D1_DIAGNOSTICS " + JSON.stringify(summary) + "\n"),
        ),
    );
    assert.equal(output.rejected, false);
    assert.equal(output.fixtures.length, 2);
    assert.ok(Buffer.byteLength(JSON.stringify(output.fixtures)) <= 16384);
});

/** 不同原生操作的边界必须独立结算，后到的 seed 终态不能闭合先前缺失的拒绝观察终态；创建阶段也不能闭合操作阶段，因此进程突然退出后即使出现其他合法记录仍然明确保留不完整事实。 */
test("native terminal cannot close another operation entered boundary", () => {
    const filter = vault.createDarwinDiagnosticFilter();
    filter.push(frame(nativeRecord("read-denial", "baseline", "entered")));
    filter.push(frame(nativeRecord("seed", "done", "passed")));
    filter.push(frame({ schemaVersion: 1, stage: "CLEANUP_DELETE", state: "passed" }));
    filter.close(0, null);
    const summary = filter.finish(1);
    assert.equal(summary.rejected, false);
    assert.equal(summary.incomplete, true);
    assert.deepEqual(collect(summary).fixtures, [summary]);
});
