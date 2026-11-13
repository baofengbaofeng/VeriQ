import assert from "node:assert/strict";
import test from "node:test";
import type { Session } from "electron";
import { HostSession } from "../src/main/session.ts";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const runId = "22222222-2222-4222-8222-222222222222";
const operation = {
    operation: "streamRunReport" as const,
    params: { workspaceId, runId },
    data: {},
};

/** 宿主网络边界在单测中只替换 Electron 的 fetch 与清理方法，返回标准 Response 和真实 ReadableStream；延迟响应由测试显式释放，以确定覆盖并发请求与会话切换发生的准确先后顺序。 */
function fixture() {
    const pending: ((response: Response) => void)[] = [];
    const session = {
        fetch: () => new Promise<Response>((resolve) => pending.push(resolve)),
        clearStorageData: async () => {},
    } as Pick<Session, "fetch" | "clearStorageData">;
    const host = new HostSession(session, "https://platform.example");
    host.workspace = { id: workspaceId, key: "unit", name: "Unit", role: "OWNER", archived: false };
    return { host, pending };
}

/** 尚未返回响应头的订阅同样占用四条流的预算，第五条必须在发出网络请求前拒绝；释放任一实际 reader 后允许新订阅，避免仅统计已建立连接而放大并发资源占用。 */
test("pending report streams reserve the same four-slot budget", async () => {
    const { host, pending } = fixture();
    const opened = Array.from({ length: 4 }, () => host.openStream(operation));
    const fifth = host.openStream(operation);
    const rejected = assert.rejects(fifth, /STREAM_OPERATION_DENIED/);
    for (const resolve of pending) resolve(new Response("data: report\n\n"));
    await rejected;
    const ids = await Promise.all(opened);
    assert.equal(pending.length, 4);
    await host.closeStream(ids[0]!);
    const replacement = host.openStream(operation);
    pending.at(-1)!(new Response("data: replacement\n\n"));
    await host.closeStream(await replacement);
    for (const id of ids.slice(1)) await host.closeStream(id);
});

/** 网络层可能已经完成响应头而取消信号尚未传播到 reader，会话失效必须再次检查订阅所属代次；旧响应体需要被实际取消，不能重新登记为新会话可读取的报告流。 */
test("a late stream response cannot survive session invalidation", async () => {
    const { host, pending } = fixture();
    let cancelled = false;
    const stream = host.openStream(operation);
    const rejected = assert.rejects(stream, /STREAM_SESSION_CHANGED/);
    host.invalidate();
    pending[0]!(
        new Response(
            new ReadableStream({
                cancel() {
                    cancelled = true;
                },
            }),
        ),
    );
    await rejected;
    assert.equal(cancelled, true);
});

/** 设备码无效并不能撤销员工的普通 Cookie 会话，只有普通鉴权失效才清除宿主用户与工作区；这里把两种真实 HTTP 状态相同而领域错误不同的响应分别送入统一 JSON 处理路径。 */
test("enrollment rejection preserves ordinary authentication but session rejection clears it", async () => {
    const { host, pending } = fixture();
    host.user = {
        user: { id: runId, email: "unit@example.com", displayName: "Unit", disabled: false },
        expiresAt: "2030-01-01T00:00:00Z",
    };
    const original = host.user;
    const first = host.cloud({ operation: "getAccount" });
    pending[0]!(Response.json({ code: "ENROLLMENT_INVALID" }, { status: 401 }));
    await assert.rejects(first, /ENROLLMENT_INVALID/);
    assert.equal(host.user, original);
    assert.equal(host.workspace?.id, workspaceId);
    const second = host.cloud({ operation: "getAccount" });
    pending[1]!(Response.json({ code: "SESSION_EXPIRED" }, { status: 401 }));
    await assert.rejects(second, /SESSION_EXPIRED/);
    assert.equal(host.user, undefined);
    assert.equal(host.workspace, undefined);
});

/** 普通登出必须实际发送共享契约要求的空 JSON 对象，成功后才完成服务器撤销路径；不允许仅清空本地用户摘要就当作退出成功，同时网络失败也必须无条件清理宿主 Cookie 与旧作用域。 */
test("logout sends canonical empty JSON and always clears the ordinary session", async () => {
    let requests = 0;
    let cleared = 0;
    let unavailable = false;
    const host = new HostSession(
        {
            fetch: async (_url, init) => {
                requests++;
                assert.equal(init?.method, "POST");
                assert.equal(init?.body, "{}");
                if (unavailable) throw new Error("CONTROL_OFFLINE");
                return Response.json({ data: {} });
            },
            clearStorageData: async () => {
                cleared++;
            },
        },
        "https://platform.example",
    );
    await host.logout();
    assert.equal(requests, 1);
    assert.equal(cleared, 1);
    unavailable = true;
    await assert.rejects(host.logout(), /CONTROL_OFFLINE/);
    assert.equal(requests, 2);
    assert.equal(cleared, 2);
});
