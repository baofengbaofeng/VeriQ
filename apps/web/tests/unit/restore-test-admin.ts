/**
 * 管理员恢复回归只在独立环回服务上核对测试清理协议，真实请求由锁定单源客户端与 Cookie 容器发出，不启动浏览器或数据库。
 * 该服务验证请求目标、Cookie 隔离、CSRF 和 Origin 的传递，但不能代替 Tornado 认证、GUI 或真实管理员审批验收。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, type Dispatcher } from "undici";
import { CookieJar } from "tough-cookie";
import { restoreTestAdmin } from "../support/restore-test-admin.js";
import { withCleanup } from "../support/case-profile-cleanup.js";

/**
 * 成功响应按仓库现有接口契约校验后才能进入恢复夹具，普通登录用户不得附加管理员字段，避免合成数据掩盖真实差异。
 * 校验器复用契约包已锁定的依赖与原始定义，不创建第二套用户字段表；诊断只报告校验结果，不输出认证内容。
 */
const contractRequire = createRequire(import.meta.resolve("@veriq/contracts"));
const { Ajv2020 } = contractRequire("ajv/dist/2020.js");
const addFormats = contractRequire("ajv-formats");
const parser = contractRequire("@apidevtools/swagger-parser");
const contractRoot = new URL("../", import.meta.resolve("@veriq/contracts"));
const api = await parser.parse(fileURLToPath(new URL("openapi/platform.yaml", contractRoot)));
const validator = new Ajv2020({ strict: true, allErrors: true });
addFormats(validator);
validator.addSchema(JSON.parse(await readFile(new URL("schemas/platform-v1.schema.json", contractRoot), "utf8")));
const apiId = "https://veriq.dev/openapi/platform.yaml";
validator.addSchema({
    $id: apiId,
    $defs: JSON.parse(
        JSON.stringify(api.components.schemas, (key, value: unknown) =>
            key === "$ref" && typeof value === "string"
                ? value.replace(/^#\/components\/schemas\//, "#/$defs/")
                : value,
        ),
    ),
});
const backupUser = {
    id: "22222222-2222-4222-8222-222222222222",
    email: "backup@example.test",
    displayName: "Backup administrator",
    disabled: false,
};
const accountUser = { ...backupUser, systemAdmin: true, createdAt: "2026-11-17T00:00:00Z" };
const session = { user: backupUser, csrfToken: "authenticated-csrf", expiresAt: "2026-11-18T00:00:00Z" };
assert.equal(validator.getSchema(`${apiId}#/$defs/SessionDTO`)(session), true);
assert.equal(validator.getSchema(`${apiId}#/$defs/AdminUserDTO`)(accountUser), true);
assert.equal(validator.getSchema(`${apiId}#/$defs/UserDTO`)({ ...backupUser, systemAdmin: true }), false);

/**
 * 每个场景拥有单独端口及角色状态，拒绝登录、错误身份和写入失败均由受控 HTTP 响应表达，不替换请求客户端或伪造通过结果。
 * 所有凭据、Cookie 和 CSRF 均为该服务内部合成值；断言只输出布尔事实，不能在失败诊断中转储认证字节。
 */
async function fixture(
    mode:
        | "ok"
        | "login-denied"
        | "patch-denied"
        | "wrong-principal"
        | "disabled-login"
        | "invalid-login-id"
        | "missing-login-name"
        | "wrong-account-id"
        | "wrong-account-email"
        | "disabled-account"
        | "non-admin-account"
        | "missing-account-role"
        | "account-denied"
        | "account-redirect"
        | "invalid-json"
        | "network-failure"
        | "setup-redirect"
        | "login-redirect"
        | "patch-redirect"
        | "missing-setup-csrf"
        | "missing-login-csrf"
        | "wrong-target"
        | "cleanup-failure"
        | "slow-body",
) {
    const targetId = "11111111-1111-4111-8111-111111111111";
    let origin = "";
    let promoted = false;
    const paths: string[] = [];
    const violations: string[] = [];
    const resources: {
        client: Client;
        jar: CookieJar;
        bodies: Dispatcher.ResponseData["body"][];
        shutdown: () => Promise<void>;
    }[] = [];
    let foreignRequests = 0;
    const foreign = createServer(async (incoming, outgoing) => {
        foreignRequests += 1;
        for await (const _chunk of incoming) {
        }
        outgoing.setHeader("Content-Type", "application/json");
        outgoing.end(
            JSON.stringify({
                data: {
                    csrfToken: "foreign-csrf",
                    user: backupUser,
                    id: targetId,
                    email: "owner@example.test",
                    systemAdmin: true,
                },
            }),
        );
    });
    foreign.listen(0, "127.0.0.1");
    await once(foreign, "listening");
    const foreignAddress = foreign.address();
    assert.ok(foreignAddress && typeof foreignAddress !== "string");
    const server = createServer(async (incoming, outgoing) => {
        const path = incoming.url ?? "";
        paths.push(path);
        const chunks: Buffer[] = [];
        for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
        const data = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
        outgoing.setHeader("Content-Type", "application/json");
        const redirect =
            (mode === "setup-redirect" && path === "/api/v1/setup") ||
            (mode === "login-redirect" && path === "/api/v1/auth/login") ||
            (mode === "account-redirect" && path === "/api/v1/account") ||
            (mode === "patch-redirect" && path === `/api/v1/admin/users/${targetId}`);
        if (redirect) {
            outgoing.statusCode = mode === "setup-redirect" ? 302 : mode === "login-redirect" ? 307 : 308;
            outgoing.setHeader("Location", `http://127.0.0.1:${foreignAddress.port}${path}`);
            return void outgoing.end("{}");
        }
        if (path === "/api/v1/setup" && incoming.method === "GET") {
            // 新上下文必须先取得自己的匿名令牌；遗留浏览器会话或跳过握手都应让后续认证检查失败，而非默认允许补丁。
            if (incoming.headers.cookie) violations.push("shared-session");
            outgoing.setHeader("Set-Cookie", "fixture=anonymous; Path=/; HttpOnly");
            if (mode === "invalid-json") return void outgoing.end("private-invalid-response");
            if (mode === "slow-body") return void outgoing.write('{"data":');
            return void outgoing.end(
                JSON.stringify({
                    data: { initialized: true, csrfToken: mode === "missing-setup-csrf" ? "" : "anonymous-csrf" },
                }),
            );
        }
        if (incoming.headers.origin !== origin) violations.push("origin");
        if (path === "/api/v1/auth/login" && incoming.method === "POST") {
            // 登录必须携带匿名握手的 Cookie 与令牌，并使用既有备用账号；响应另发认证会话和令牌，二者不能混用。
            if (incoming.headers.cookie !== "fixture=anonymous") violations.push("login-cookie");
            if (incoming.headers["x-csrf-token"] !== "anonymous-csrf") violations.push("login-csrf");
            if (data.email !== "backup@example.test" || data.password !== "fixture-only")
                violations.push("login-actor");
            if (mode === "login-denied") outgoing.statusCode = 401;
            outgoing.setHeader("Set-Cookie", "fixture=authenticated; Path=/; HttpOnly");
            return void outgoing.end(
                JSON.stringify({
                    data: {
                        ...session,
                        csrfToken: mode === "missing-login-csrf" ? "" : session.csrfToken,
                        user: {
                            ...backupUser,
                            email: mode === "wrong-principal" ? "other@example.test" : backupUser.email,
                            disabled: mode === "disabled-login",
                            id: mode === "invalid-login-id" ? "invalid" : backupUser.id,
                            displayName: mode === "missing-login-name" ? undefined : backupUser.displayName,
                        },
                    },
                }),
            );
        }
        if (path === "/api/v1/account" && incoming.method === "GET") {
            if (incoming.headers.cookie !== "fixture=authenticated") violations.push("account-cookie");
            if (mode === "account-denied") outgoing.statusCode = 403;
            return void outgoing.end(
                JSON.stringify({
                    data: {
                        ...accountUser,
                        id: mode === "wrong-account-id" ? targetId : backupUser.id,
                        email: mode === "wrong-account-email" ? "other@example.test" : backupUser.email,
                        disabled: mode === "disabled-account",
                        systemAdmin: mode === "missing-account-role" ? undefined : mode !== "non-admin-account",
                    },
                }),
            );
        }
        if (path === `/api/v1/admin/users/${targetId}` && incoming.method === "PATCH") {
            // 只有固定目标和明确 true 写入才算恢复；认证 Cookie、令牌及 Origin 都在服务器侧核对，不能仅比较调用次数。
            if (incoming.headers.cookie !== "fixture=authenticated") violations.push("patch-cookie");
            if (incoming.headers["x-csrf-token"] !== "authenticated-csrf") violations.push("patch-csrf");
            if (JSON.stringify(data) !== JSON.stringify({ systemAdmin: true })) violations.push("patch-body");
            if (mode === "network-failure") return outgoing.destroy();
            if (mode === "patch-denied") outgoing.statusCode = 403;
            else promoted = true;
            return void outgoing.end(
                JSON.stringify({
                    data: {
                        id: mode === "wrong-target" ? "foreign-id" : targetId,
                        email: "owner@example.test",
                        displayName: "Recovery owner",
                        disabled: false,
                        systemAdmin: true,
                        createdAt: "2026-11-16T00:00:00Z",
                    },
                }),
            );
        }
        violations.push("unexpected-endpoint");
        outgoing.statusCode = 404;
        outgoing.end("{}");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    origin = `http://127.0.0.1:${address.port}`;
    const recover = () =>
        restoreTestAdmin(
            {
                origin,
                targetId,
                targetEmail: "owner@example.test",
                backupEmail: "backup@example.test",
                backupPassword: "fixture-only",
            },
            (boundOrigin) => {
                const client = new Client(boundOrigin, { maxResponseSize: 64 * 1024 });
                const jar = new CookieJar();
                const bodies: Dispatcher.ResponseData["body"][] = [];
                const send = client.request.bind(client);
                const destroy = client.destroy.bind(client);
                const shutdown = () => new Promise<void>((resolve) => destroy(null, resolve));
                // 包装只记录真实响应流，不替换网络结果；释放断言读取公开状态并实际尝试关闭后请求，避免把存在当作释放。
                client.request = (async (options: Dispatcher.RequestOptions) => {
                    const response = await send(options);
                    bodies.push(response.body);
                    return response;
                }) as Client["request"];
                if (mode === "cleanup-failure") {
                    client.destroy = (async () => {
                        await shutdown();
                        throw new Error("synthetic-private-client-diagnostic");
                    }) as Client["destroy"];
                    const clear = jar.removeAllCookiesSync.bind(jar);
                    jar.removeAllCookiesSync = () => {
                        clear();
                        throw new Error("synthetic-private-cookie-diagnostic");
                    };
                }
                resources.push({ client, jar, bodies, shutdown });
                return { client, jar };
            },
        );
    return {
        recover,
        paths,
        violations,
        resources,
        promoted: () => promoted,
        foreignRequests: () => foreignRequests,
        async close() {
            // 所有进入过网络阶段的成功和失败分支都必须释放独立上下文；关闭后再次请求应被客户端拒绝，不会触达服务。
            try {
                for (const { client, jar, bodies } of resources) {
                    assert.equal(client.destroyed, true);
                    await assert.rejects(client.request({ path: "/", method: "GET" }), { code: "UND_ERR_DESTROYED" });
                    assert.equal(jar.serializeSync()?.cookies?.length === 0, true);
                    assert.equal(bodies.length > 0, true);
                    assert.equal(
                        bodies.every((body) => body.destroyed && body.closed),
                        true,
                    );
                }
            } finally {
                await Promise.all(resources.map(({ shutdown }) => shutdown()));
                await new Promise<void>((resolve, reject) =>
                    foreign.close((error) => (error ? reject(error) : resolve())),
                );
                await new Promise<void>((resolve, reject) =>
                    server.close((error) => (error ? reject(error) : resolve())),
                );
            }
        },
    };
}

/**
 * 成功场景从已降权状态开始，独立恢复真实经过握手和登录后仅更新指定账号；最后角色事实与协议记录必须同时满足预期。
 * 服务器验证固定预期，不从响应复制权限真值；上下文关闭也由后续请求实际被拒绝来证明。
 */
test("restores only the owned target through an independent authenticated context", async () => {
    const current = await fixture("ok");
    await withCleanup(async () => {
        await current.recover();
        assert.equal(current.promoted(), true);
        assert.deepEqual(current.violations, []);
        assert.deepEqual(current.paths, [
            "/api/v1/setup",
            "/api/v1/auth/login",
            "/api/v1/account",
            "/api/v1/admin/users/11111111-1111-4111-8111-111111111111",
        ]);
    }, current.close);
});

/**
 * 登录拒绝、非管理员身份和未知 JSON 都不能进入权限写入，分别覆盖 HTTP、身份与数据边界，而非一律把异常吞掉当作成功。
 * 每轮仍检查上下文已关闭；账户负例必须真实到达同一会话的读取阶段，目标账号的已降权状态必须保持。
 */
for (const mode of [
    "login-denied",
    "wrong-principal",
    "disabled-login",
    "invalid-login-id",
    "missing-login-name",
    "wrong-account-id",
    "wrong-account-email",
    "disabled-account",
    "non-admin-account",
    "missing-account-role",
    "account-denied",
    "invalid-json",
    "missing-setup-csrf",
    "missing-login-csrf",
] as const) {
    test(`${mode} fails closed without a role mutation`, async () => {
        const current = await fixture(mode);
        await withCleanup(async () => {
            const expected =
                mode === "login-denied"
                    ? "login: HTTP 401"
                    : mode === "account-denied"
                      ? "account: HTTP 403"
                      : mode === "invalid-json"
                        ? "setup: invalid JSON"
                        : mode === "missing-setup-csrf"
                          ? "setup: missing CSRF"
                          : mode === "missing-login-csrf"
                            ? "login: missing CSRF"
                            : `${mode.includes("account") ? "account" : "login"}: unexpected principal`;
            await assert.rejects(current.recover(), { message: `Test admin recovery ${expected}` });
            if (mode.includes("account"))
                assert.deepEqual(current.paths, ["/api/v1/setup", "/api/v1/auth/login", "/api/v1/account"]);
            assert.equal(current.promoted(), false);
            assert.equal(
                current.paths.some((path) => path.includes("/admin/users/")),
                false,
            );
            assert.deepEqual(current.violations, []);
        }, current.close);
    });
}

/**
 * 服务端拒绝权限补丁时必须保留明确失败，即使拒绝响应故意含有看似成功的 data；恢复不能只看正文而忽略 HTTP 状态。
 * 诊断仅断言公开阶段与状态，不打印请求头、Cookie、密码或令牌，同时验证独立上下文仍会释放。
 */
test("a denied role patch remains a cleanup failure", async () => {
    const current = await fixture("patch-denied");
    await withCleanup(async () => {
        await assert.rejects(current.recover(), /role restore.*403/i);
        assert.equal(current.promoted(), false);
        assert.deepEqual(current.violations, []);
    }, current.close);
});

/**
 * 带认证信息的请求在网络阶段失败时，只能输出固定阶段诊断；底层客户端的调用日志可能含请求头，不能随错误传给测试报告。
 * 服务故意断开补丁连接，角色保持原值，实际上下文仍须释放；这里不重试请求，也不把断连误报成恢复成功。
 */
test("network failures expose only a fixed recovery diagnostic", async () => {
    const current = await fixture("network-failure");
    await withCleanup(async () => {
        await assert.rejects(current.recover(), (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.ok(error.message === "Test admin recovery role restore: request failed");
            return true;
        });
        assert.equal(current.promoted(), false);
        assert.deepEqual(current.violations, []);
    }, current.close);
});

/**
 * 正文断言与恢复补丁同时失败时，既有清理结算器必须保留原始正文对象作为首因，并保留实际 HTTP 恢复错误而非替换其结论。
 * 这只证明失败清理的错误组合，不声称本地协议服务已经验收真实自降权、退出意图或 Runtime 信任审批。
 */
test("body and recovery failures retain both causes", async () => {
    const current = await fixture("patch-denied");
    const primary = new Error("original GUI assertion");
    await withCleanup(async () => {
        await assert.rejects(
            withCleanup(async () => {
                throw primary;
            }, current.recover),
            (error: unknown) => {
                assert.ok(error instanceof AggregateError);
                assert.equal(error.errors[0], primary);
                assert.equal(error.cause, primary);
                assert.match(String(error.errors[1]), /role restore.*403/i);
                return true;
            },
        );
    }, current.close);
});

/**
 * 四个恢复阶段都用第二个真实环回源提供看似正确的成功正文，跳转不得转送认证数据，也不得成为权限恢复成功的依据。
 * 初始握手覆盖普通跳转，登录和补丁分别覆盖保留方法与正文的跳转；外源必须始终没有收到请求。
 */
for (const mode of ["setup-redirect", "login-redirect", "account-redirect", "patch-redirect"] as const) {
    test(`${mode} rejects foreign replies without contacting the destination`, async () => {
        const current = await fixture(mode);
        await withCleanup(async () => {
            let rejected = false;
            try {
                await current.recover();
            } catch {
                rejected = true;
            }
            assert.deepEqual(
                { rejected, foreignUntouched: current.foreignRequests() === 0, targetUnchanged: !current.promoted() },
                { rejected: true, foreignUntouched: true, targetUnchanged: true },
            );
        }, current.close);
    });
}

/**
 * 两次恢复必须拥有不同客户端和内存 Cookie 容器，第二次握手不能继承上次会话；每轮完成后都检查清空与关闭事实。
 * 服务继续验证两个阶段的真实 Cookie 和令牌，连接、响应流及 Cookie 条目最终都不能供后续请求复用。
 */
test("successive recoveries own separate cleared jars and closed clients", async () => {
    const current = await fixture("ok");
    await withCleanup(async () => {
        await current.recover();
        await current.recover();
        assert.equal(current.resources[0].client !== current.resources[1].client, true);
        assert.equal(current.resources[0].jar !== current.resources[1].jar, true);
        assert.equal(current.paths.length, 8);
        assert.deepEqual(current.violations, []);
    }, current.close);
});

/**
 * 补丁正文即使含有 true，也必须绑定原本已知目标；错误标识不能被当作已经恢复，实际资源仍须进入统一释放路径。
 * 清理故障在真实销毁与清空之后注入秘密诊断，验证两个清理动作都结算，向外只保留固定错误与错误顺序。
 */
for (const mode of ["wrong-target", "cleanup-failure"] as const) {
    test(`${mode} fails closed with settled resources and sanitized diagnostics`, async () => {
        const current = await fixture(mode);
        await withCleanup(async () => {
            await assert.rejects(current.recover(), (error: unknown) => {
                if (mode === "wrong-target") {
                    assert.equal(
                        error instanceof Error &&
                            error.message === "Test admin recovery role restore: unexpected target",
                        true,
                    );
                } else {
                    assert.ok(error instanceof AggregateError);
                    assert.equal(error.errors.length, 2);
                    assert.equal(error.errors[0].message === "Test admin recovery: client cleanup failed", true);
                    assert.equal(error.errors[1].message === "Test admin recovery: cookie cleanup failed", true);
                    assert.equal(error.cause === error.errors[0], true);
                    assert.equal(
                        error.errors.every((item: Error) => item.cause === undefined),
                        true,
                    );
                }
                return true;
            });
            assert.deepEqual(current.violations, []);
        }, current.close);
    });
}

/**
 * 服务发送响应头后故意不结束正文，真实请求必须仍在五秒总预算内中止；只检查失败、无补丁及已释放资源的事实。
 * 这个挂起由客户端中止事件结束，不使用固定等待来模拟成功，也不把仅有响应头误认为恢复已经完成。
 */
test("the request deadline includes a stalled response body", { timeout: 10_000 }, async () => {
    const current = await fixture("slow-body");
    const started = performance.now();
    await withCleanup(async () => {
        await assert.rejects(current.recover(), /setup: invalid JSON/);
        assert.equal(performance.now() - started < 7_500, true);
        assert.equal(current.paths.length === 1 && !current.promoted(), true);
    }, current.close);
});

/**
 * 恢复参数只允许完整的可信源和单个固定用户标识，路径、凭据或查询拼接在创建客户端之前被拒绝，不能改写目标端点。
 * 工厂探针只记录是否被调用，不制造网络结果；所有拒绝都必须停在尚未拥有任何网络资源的入口边界。
 */
test("invalid origins and target paths are rejected before client creation", async () => {
    for (const [origin, targetId] of [
        ["http://127.0.0.1:5173/foreign", "11111111-1111-4111-8111-111111111111"],
        ["http://private:credential@127.0.0.1:5173", "11111111-1111-4111-8111-111111111111"],
        ["http://127.0.0.1:5173", "../foreign"],
    ]) {
        let created = false;
        await assert.rejects(
            restoreTestAdmin(
                {
                    origin,
                    targetId,
                    targetEmail: "owner@example.test",
                    backupEmail: "backup@example.test",
                    backupPassword: "fixture-only",
                },
                () => {
                    created = true;
                    throw new Error("Unexpected resource creation");
                },
            ),
            /invalid endpoint/,
        );
        assert.equal(created, false);
    }
});

/**
 * 此回归启动真正的无浏览器运行器并保留两个受控失败的追踪，逐个解压全部成员检查动态哨兵，而非只检查最终错误消息。
 * 私有侧车不加入追踪；Python 标准 ZIP 实现同时检查原文、JSON 转义和编码正文，输出仅含布尔事实。
 */
test("retained Playwright traces exclude recovery credentials after cleanup", { timeout: 40_000 }, async (context) => {
    const evidenceRoot = process.env.VERIQ_RECOVERY_AUDIT_DIR;
    if (evidenceRoot) await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(join(evidenceRoot ?? tmpdir(), "veriq-recovery-trace-"));
    await withCleanup(
        async () => {
            const config = join(directory, "playwright.config.cjs");
            const reportPath = join(directory, "report.json");
            await writeFile(
                config,
                `module.exports = ${JSON.stringify({
                    testDir: join(dirname(fileURLToPath(import.meta.url)), "fixtures"),
                    testMatch: "restore-test-admin-trace.fixture.ts",
                    workers: 1,
                    retries: 0,
                    timeout: 10_000,
                    globalTimeout: 20_000,
                    outputDir: join(directory, "results"),
                    reporter: [["json", { outputFile: reportPath }]],
                    use: { trace: "retain-on-failure" },
                })};`,
                { mode: 0o600 },
            );
            const require = createRequire(import.meta.url);
            const run = spawnSync(
                process.execPath,
                [require.resolve("@playwright/test/cli"), "test", "--config", config],
                {
                    env: { ...process.env, VERIQ_RECOVERY_PROBE_DIR: directory },
                    encoding: "utf8",
                    timeout: 30_000,
                    maxBuffer: 1024 * 1024,
                },
            );
            await writeFile(join(directory, "runner.log"), run.stdout + run.stderr, { mode: 0o600 });
            const report = JSON.parse(await readFile(reportPath, "utf8"));
            const audit = spawnSync(
                "python3",
                [
                    "-c",
                    `
import base64, json, pathlib, re, sys, zipfile
root = pathlib.Path(sys.argv[1])
sentinels = []
facts = []
for mode in ("success", "network-failure"):
    data = json.loads((root / (mode + ".json")).read_text())
    sentinels.extend(data.pop("sentinels"))
    facts.append(data["cleanupSettled"] and data["protocolValid"] and data["requests"] == 4
        and data["recovered"] == (mode == "success") and data["patched"] == data["recovered"]
        and data["fixedFailure"] == (mode == "network-failure"))
needles = [variant.encode() for value in sentinels for variant in
    (value, json.dumps(value)[1:-1], base64.b64encode(value.encode()).decode())]
leaked = False
positive = 0
members = 0
archives = list((root / "results").rglob("*.zip"))
blobs = [(root / "runner.log").read_bytes(), (root / "report.json").read_bytes()]
blobs.extend(path.read_bytes() for path in (root / "results").rglob("*") if path.is_file() and path.suffix != ".zip")
for archive in archives:
    with zipfile.ZipFile(archive) as zipped:
        marked = False
        for member in zipped.infolist():
            members += 1
            content = zipped.read(member)
            blobs.append(content)
            if member.filename.endswith(".trace"):
                for line in content.splitlines():
                    event = json.loads(line)
                    marked |= (event.get("type") == "before" and event.get("method") == "test.step"
                        and event.get("title") == "trace-positive-control")
        positive += marked
for blob in blobs:
    decoded = []
    for token in re.findall(rb"[A-Za-z0-9+/]{16,}={0,2}", blob):
        try:
            decoded.append(base64.b64decode(token + b"=" * (-len(token) % 4), validate=True))
        except ValueError:
            pass
    leaked |= any(needle in content for needle in needles for content in [blob, *decoded])
report = json.loads((root / "report.json").read_text())
def results(suite):
    return [result for spec in suite.get("specs", []) for test in spec["tests"] for result in test["results"]] + [
        result for child in suite.get("suites", []) for result in results(child)]
recorded = results(report)
controlled = len(recorded) == 2 and all(
    result["status"] == "failed" and len(result["errors"]) == 1
    and result["errors"][0]["message"].splitlines()[0] == "Error: Controlled recovery trace probe failure"
    for result in recorded)
print(json.dumps({"controlledBodyFailures": controlled, "twoRetainedArchives": len(archives) == 2,
    "nonemptyMembers": members > 0,
    "positiveTraceControl": positive == 2, "protocolAndCleanup": all(facts), "secretLeak": leaked}))
`,
                    directory,
                ],
                { encoding: "utf8", timeout: 5_000, maxBuffer: 1024 * 1024 },
            );
            assert.equal(audit.status === 0 && audit.signal === null, true);
            const facts = JSON.parse(audit.stdout);
            context.diagnostic(JSON.stringify({ expectedRunnerExit: run.status === 1, ...facts }));
            assert.equal(run.status === 1 && run.signal === null, true);
            assert.equal(report.stats.unexpected === 2 && report.stats.skipped === 0, true);
            assert.deepEqual(facts, {
                controlledBodyFailures: true,
                twoRetainedArchives: true,
                nonemptyMembers: true,
                positiveTraceControl: true,
                protocolAndCleanup: true,
                secretLeak: false,
            });
        },
        async () => {
            if (!evidenceRoot) await rm(directory, { recursive: true, force: true });
        },
    );
});
