/**
 * 测试以独立内存对象复现浏览器还能读取旧会话条目却无法写入或删除的情况，请求编号与摘要由真实提交逻辑生成。
 */
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { agentSubmission, clearAgentSubmission, hasPendingAgentConfirmation } from "../../src/features/agent/retry";

// 只让写入和删除失败，读取继续返回原持久值，测试结束恢复全局属性且不打开 Node 的实际存储文件。
function sessionFixture(context: TestContext) {
    const entries = new Map<string, string>();
    const faults = { set: false, remove: false };
    const storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> = {
        getItem: (key) => entries.get(key) ?? null,
        setItem(key, value) {
            if (faults.set) {
                throw new DOMException("Storage write blocked", "QuotaExceededError");
            }
            entries.set(key, value);
        },
        removeItem(key) {
            if (faults.remove) {
                throw new DOMException("Storage removal blocked", "SecurityError");
            }
            entries.delete(key);
        },
    };
    const original = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
    Object.defineProperty(globalThis, "sessionStorage", { value: storage, configurable: true });
    context.after(() => {
        if (original) {
            Object.defineProperty(globalThis, "sessionStorage", original);
        } else {
            Reflect.deleteProperty(globalThis, "sessionStorage");
        }
    });
    return { storage, faults };
}

// 各场景保有独立会话键，将普通确认选取的已审阅提议交给生产模块，避免用固定请求编号代替真实生成。
function confirm(key: string, phrase: string, expectedProposalId: string) {
    return agentSubmission(key, phrase, { confirmation: true, expectedProposalId }, new AbortController().signal);
}

test("a readable stale entry cannot replace a newer in-page retry identity", async (context) => {
    const { storage, faults } = sessionFixture(context);
    const key = "veriq.agent.retry/browser-write";
    const old = await confirm(key, "confirm run", crypto.randomUUID());
    const persisted = storage.getItem(key);
    assert.match(persisted ?? "", new RegExp(`^[a-f0-9]{64}/${old.requestId}/${old.expectedProposalId}$`));
    faults.set = true;
    const nextTarget = crypto.randomUUID();
    const next = await confirm(key, "confirm action", nextTarget);
    assert.notEqual(next.requestId, old.requestId);
    assert.equal(storage.getItem(key), persisted);

    // 读操作仍返回较旧的三字段条目，重复正文应复用失败写入的内存身份与原目标，而非眼下看到的目标。
    const replay = await confirm(key, "confirm action", crypto.randomUUID());
    assert.deepEqual(replay, next);
});

test("a failed removal settles only the matching identity in the current page", async (context) => {
    const { storage, faults } = sessionFixture(context);
    const key = "veriq.agent.retry/browser-remove";
    const first = await confirm(key, "confirm run", crypto.randomUUID());
    const persisted = storage.getItem(key);
    faults.remove = true;
    clearAgentSubmission(key, first.requestId);
    assert.equal(storage.getItem(key), persisted);
    assert.equal(hasPendingAgentConfirmation(key), false);

    // 删除与后续写入都失败时，新提议仍能建立独立身份，同一页面中的旧拒绝不能清掉新请求的记录。
    faults.set = true;
    const newTarget = crypto.randomUUID();
    const next = await confirm(key, "confirm run", newTarget);
    assert.notEqual(next.requestId, first.requestId);
    assert.equal(next.expectedProposalId, newTarget);
    clearAgentSubmission(key, first.requestId);
    assert.equal(hasPendingAgentConfirmation(key), true);
    assert.deepEqual(await confirm(key, "confirm run", crypto.randomUUID()), next);
    clearAgentSubmission(key, next.requestId);
    assert.equal(hasPendingAgentConfirmation(key), false);
    assert.equal(storage.getItem(key), persisted);
});

test("a late rejection cannot clear a different persisted request", async (context) => {
    const { storage } = sessionFixture(context);
    const key = "veriq.agent.retry/late-rejection";
    const first = await confirm(key, "confirm run", crypto.randomUUID());
    const next = await confirm(key, "confirm action", crypto.randomUUID());
    clearAgentSubmission(key, first.requestId);
    assert.notEqual(next.requestId, first.requestId);
    assert.deepEqual(await confirm(key, "confirm action", crypto.randomUUID()), next);
    clearAgentSubmission(key, next.requestId);
    assert.equal(storage.getItem(key), null);
    assert.equal(hasPendingAgentConfirmation(key), false);
});

/**
 * 同一文件名可对应不同内容，重放只复用完全相同材料的请求编号，页面重载存储不保留文件正文或文件名。
 */
test("attachment identity binds request replay without persisting the selected files", async (context) => {
    const { storage } = sessionFixture(context);
    const key = "veriq.agent.retry/attachments";
    const signal = new AbortController().signal;
    const firstFile = { name: "private-notes.txt", mediaType: "text/plain" as const, dataBase64: "YQ==" };
    const firstFiles = [firstFile];
    const send = (attachments: typeof firstFiles) =>
        agentSubmission(key, "", { confirmation: false, attachments }, signal);
    const first = await send(firstFiles);
    assert.deepEqual(first.attachments, firstFiles);
    assert.equal((await send(firstFiles)).requestId, first.requestId);
    const second = await send([{ ...firstFile, dataBase64: "Yg==" }]);
    assert.notEqual(second.requestId, first.requestId);
    assert.match(storage.getItem(key) ?? "", /^[a-f0-9]{64}\/[a-f0-9-]{36}\/$/);
});

test("delegation choices bind request replay and automatic turns keep the original request shape", async (context) => {
    sessionFixture(context);
    const key = "veriq.agent.retry/delegation";
    const signal = new AbortController().signal;
    const send = (delegationMode?: "MAIN" | "SUBAGENT") =>
        agentSubmission(key, "Follow this run", { confirmation: false, delegationMode }, signal);
    const automatic = await send();
    assert.deepEqual(automatic, { requestId: automatic.requestId, text: "Follow this run" });
    const delegated = await send("SUBAGENT");
    assert.equal(delegated.delegationMode, "SUBAGENT");
    assert.notEqual(delegated.requestId, automatic.requestId);
    assert.deepEqual(await send("SUBAGENT"), delegated);
    const main = await send("MAIN");
    assert.equal(main.delegationMode, "MAIN");
    assert.notEqual(main.requestId, delegated.requestId);
});
