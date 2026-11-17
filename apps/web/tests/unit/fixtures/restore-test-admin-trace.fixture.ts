/**
 * 此夹具只由隔离配置启动真实测试运行器，故意保留正文失败的追踪，以检查恢复请求的认证内容是否进入最终制品。
 * 文件名不参与普通 GUI 或 Node 单测匹配；合成哨兵在运行时生成，私有侧车供外层逐字节审计。
 */
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { test, expect } from "@playwright/test";
import { restoreTestAdmin } from "../../support/restore-test-admin";

/**
 * 失败后的清理真实执行握手、登录和固定目标补丁，成功与网络中断各一例；服务器只接受本轮生成的凭据和令牌。
 * 最终侧车只在恢复 promise 与服务关闭均已结算后落盘，因此审计覆盖清理完成后的保留追踪。
 */
test.afterEach(async () => {
    const testInfo = test.info();
    const mode = testInfo.title;
    const directory = process.env.VERIQ_RECOVERY_PROBE_DIR;
    if (!directory) throw new Error("Missing isolated recovery probe directory");
    const password = `${randomUUID()}"\\`;
    const anonymousCsrf = randomUUID();
    const authenticatedCsrf = randomUUID();
    const anonymousCookie = randomUUID();
    const authenticatedCookie = randomUUID();
    const targetId = "11111111-1111-4111-8111-111111111111";
    let origin = "";
    let protocolValid = true;
    let patched = false;
    let requests = 0;
    const server = createServer(async (incoming, outgoing) => {
        requests += 1;
        const chunks: Buffer[] = [];
        for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
        const data = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
        outgoing.setHeader("Content-Type", "application/json");
        if (incoming.url === "/api/v1/setup" && incoming.method === "GET") {
            protocolValid &&= !incoming.headers.cookie;
            outgoing.setHeader("Set-Cookie", `fixture=${anonymousCookie}; Path=/; HttpOnly`);
            return void outgoing.end(JSON.stringify({ data: { csrfToken: anonymousCsrf } }));
        }
        protocolValid &&= incoming.headers.origin === origin;
        if (incoming.url === "/api/v1/auth/login" && incoming.method === "POST") {
            protocolValid &&= incoming.headers.cookie === `fixture=${anonymousCookie}`;
            protocolValid &&= incoming.headers["x-csrf-token"] === anonymousCsrf;
            protocolValid &&= data.email === "backup@example.test" && data.password === password;
            outgoing.setHeader("Set-Cookie", `fixture=${authenticatedCookie}; Path=/; HttpOnly`);
            return void outgoing.end(
                JSON.stringify({
                    data: {
                        csrfToken: authenticatedCsrf,
                        user: { email: "backup@example.test", systemAdmin: true },
                    },
                }),
            );
        }
        if (incoming.url === `/api/v1/admin/users/${targetId}` && incoming.method === "PATCH") {
            protocolValid &&= incoming.headers.cookie === `fixture=${authenticatedCookie}`;
            protocolValid &&= incoming.headers["x-csrf-token"] === authenticatedCsrf;
            protocolValid &&= JSON.stringify(data) === JSON.stringify({ systemAdmin: true });
            if (mode === "network-failure") return outgoing.destroy();
            patched = true;
            return void outgoing.end(
                JSON.stringify({
                    data: {
                        id: targetId,
                        email: "owner@example.test",
                        systemAdmin: true,
                    },
                }),
            );
        }
        protocolValid = false;
        outgoing.statusCode = 404;
        outgoing.end("{}");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing probe listener");
    origin = `http://127.0.0.1:${address.port}`;
    let recovered = false;
    let fixedFailure = false;
    try {
        await restoreTestAdmin({
            origin,
            targetId,
            targetEmail: "owner@example.test",
            backupEmail: "backup@example.test",
            backupPassword: password,
        });
        recovered = true;
    } catch (error) {
        fixedFailure = error instanceof Error && error.message === "Test admin recovery role restore: request failed";
    } finally {
        await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
        await writeFile(
            join(directory, `${mode}.json`),
            JSON.stringify({
                sentinels: [password, anonymousCsrf, authenticatedCsrf, anonymousCookie, authenticatedCookie],
                recovered,
                fixedFailure,
                patched,
                protocolValid,
                requests,
                cleanupSettled: true,
            }),
            { mode: 0o600 },
        );
    }
    expect(protocolValid && requests === 3).toBe(true);
    expect(recovered === (mode === "success") && patched === recovered).toBe(true);
    expect(fixedFailure === (mode === "network-failure")).toBe(true);
});

/**
 * 正文故意失败以触发原生 afterEach 与 retain-on-failure，两个固定错误应由外层识别，不能误报为浏览器通过。
 * 明确的步骤标记用于证明实际追踪存在且包含运行器事件，空 ZIP 或没有 trace 的结果必须被拒绝。
 */
for (const mode of ["success", "network-failure"]) {
    test(mode, async () => {
        await test.step("trace-positive-control", async () => {});
        throw new Error("Controlled recovery trace probe failure");
    });
}
