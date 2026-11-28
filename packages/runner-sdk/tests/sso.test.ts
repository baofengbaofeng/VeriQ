/**
 * 在真实 Chromium 中运行两个隔离站点和一个出站探针，逐次记录服务器收到的请求而非仅检查最终页面地址。
 * 测试证书只在独立浏览器进程按临时公钥指纹绑定，生产配置及系统信任库均不参与。
 */
import { execFileSync } from "node:child_process";
import { createHash, randomUUID, X509Certificate } from "node:crypto";
import { createSocket } from "node:dgram";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createTlsServer } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { chromium, type BrowserContext, type Browser, type BrowserServer, type Page } from "@playwright/test";
import {
    canonicalBytes,
    type BrowserSsoAuthConfigV1,
    type BrowserSsoResultV1,
    type ExecutionSnapshotV1,
} from "@veriq/contracts";
import { afterAll, beforeAll, expect, onTestFailed, test } from "vitest";
import { authenticateBusiness } from "../src/fixtures/auth.js";
import { createSsoObservation } from "./sso-observation.js";

let browser: Browser;
let browserServer: BrowserServer;
let appOrigin: string;
let idpOrigin: string;
let identityOrigin: string;
let forbiddenOrigin: string;
const servers: Server[] = [];
let redirectStatus = 303;
let denyEntry = false;
let redirectIdentity = false;
let unrelatedRead = false;
let callbackLoginMaterial: "plain" | "percent" | "base64" | undefined;
let documentEncoding: "gzip" | "br" | undefined;
let conflictingNativePolicy = false;
let manyStyles = false;
let parallelStyles = false;
let stylesPending: Promise<void> | undefined;
let callbackPage: "sync" | "microtask" | "timer" | "meta" | "api" | undefined;
let redirectHops = 0;
let releaseParser: (() => void) | undefined;
let receivedSlow: (() => void) | undefined;
const password = randomUUID();
const received: Array<{ station: string; method: string; path: string }> = [];

/**
 * 监听真实本地端口并保留关闭责任，避免拿服务端空日志证明拦截时其实从未注册过目标服务器。
 */
async function listen(server: Server): Promise<number> {
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    return (server.address() as AddressInfo).port;
}

function track(station: string, req: IncomingMessage) {
    received.push({ station, method: req.method ?? "", path: new URL(req.url ?? "/", appOrigin).pathname });
}

function redirect(res: ServerResponse, target: string, status = 302) {
    res.writeHead(status, { location: target }).end();
}

function html(res: ServerResponse, body: string) {
    const bytes =
        documentEncoding === "gzip"
            ? gzipSync(body)
            : documentEncoding === "br"
              ? brotliCompressSync(body)
              : Buffer.from(body);
    if (documentEncoding) res.setHeader("content-encoding", documentEncoding);
    res.writeHead(200, { "content-type": "text/html", "content-length": bytes.length }).end(bytes);
}

beforeAll(async () => {
    function appHandler(req: IncomingMessage, res: ServerResponse) {
        track("APP", req);
        if (req.url === "/held-business") {
            receivedSlow?.();
            return;
        }
        if (req.url === "/protected") {
            releaseParser?.();
            releaseParser = undefined;
            if (req.headers.cookie?.includes("business=1")) {
                res.setHeader("set-cookie", ["documentA=1; HttpOnly; Path=/", "documentB=1; HttpOnly; Path=/"]);
                res.setHeader("Content-Security-Policy", "script-src 'self'");
                if (conflictingNativePolicy)
                    res.setHeader("Connection-Allowlist", "(response-origin); redirects=block; webrtc=block");
                return html(res, '<main></main><script src="/demo.js"></script>');
            }
            return redirect(res, denyEntry ? forbiddenOrigin : idpOrigin + "/login?flow=one");
        }
        if (req.url === "/demo.js")
            return res
                .writeHead(200, { "content-type": "text/javascript" })
                .end('document.querySelector("main").textContent = "Business page";');
        if (req.url === "/parser.js") {
            releaseParser = () => res.writeHead(200, { "content-type": "text/javascript" }).end("");
            return;
        }
        if (req.url === "/api-landing") return html(res, "<main>API</main>");
        if (req.url?.startsWith("/chain-")) {
            const step = Number(req.url.slice("/chain-".length));
            return redirect(res, step < redirectHops ? "/chain-" + (step + 1) : "/protected", 303);
        }
        if (req.url === "/callback-script.js") {
            const target = callbackPage === "api" ? identityOrigin + "/api-landing" : "/protected";
            const navigate = "location.replace(" + JSON.stringify(target) + ")";
            let script = navigate;
            if (callbackPage === "microtask") script = "Promise.resolve().then(()=>" + navigate + ")";
            if (callbackPage === "timer") script = "setTimeout(()=>" + navigate + ",0)";
            return res.writeHead(200, { "content-type": "text/javascript" }).end(script);
        }
        if (req.url === "/callback" && req.method === "GET") {
            res.setHeader("set-cookie", "business=1; HttpOnly; SameSite=Lax; Path=/");
            if (callbackPage === "meta") return html(res, '<meta http-equiv="refresh" content="0;url=/protected">');
            if (callbackPage)
                return html(
                    res,
                    '<script src="/callback-script.js"></script>' +
                        (callbackPage === "timer" ? '<script src="/parser.js"></script>' : ""),
                );
            if (redirectHops) return redirect(res, "/chain-1", 303);
            return redirect(res, "/protected", 303);
        }
        if (req.url === "/me" && req.headers.cookie?.includes("business=1")) {
            if (redirectIdentity) return redirect(res, "/identity-redirect");
            return res.writeHead(200, { "content-type": "application/json" }).end('{"identity":"tester"}');
        }
        res.writeHead(403).end();
    }
    const forbidden = createServer((req, res) => {
        track("FORBIDDEN", req);
        html(res, "");
    });
    forbiddenOrigin = "http://127.0.0.1:" + (await listen(forbidden));

    const certDir = mkdtempSync(join(tmpdir(), "veriq-sso-cert-"));
    try {
        const certificate = join(certDir, "tls.pem");
        const key = join(certDir, "tls.key");
        execFileSync(
            "openssl",
            [
                "req",
                "-new",
                "-x509",
                "-nodes",
                "-newkey",
                "rsa:2048",
                "-days",
                "1",
                "-subj",
                "/CN=localhost",
                "-out",
                certificate,
                "-keyout",
                key,
            ],
            { stdio: "ignore" },
        );
        const cert = readFileSync(certificate);
        const publicKey = new X509Certificate(cert).publicKey.export({ type: "spki", format: "der" });
        const fingerprint = createHash("sha256").update(publicKey).digest("base64");
        const keyBytes = readFileSync(key);
        const app = createTlsServer({ key: keyBytes, cert }, appHandler);
        appOrigin = "https://127.0.0.1:" + (await listen(app));
        identityOrigin = "https://127.0.0.1:" + (await listen(createTlsServer({ key: keyBytes, cert }, appHandler)));
        const idp = createTlsServer({ key: keyBytes, cert }, async (req, res) => {
            track("IDP", req);
            if (req.url?.startsWith("/style-")) {
                await stylesPending;
                return res.writeHead(200, { "content-type": "text/css" }).end("form{}");
            }
            if (req.url === "/unrelated") return res.writeHead(204).end();
            if (req.method === "POST" && req.url === "/submit") {
                let body = "";
                for await (const chunk of req) body += String(chunk);
                const values = new URLSearchParams(body);
                if (values.get("user") === "tester" && values.get("password") === password) {
                    const encoded =
                        callbackLoginMaterial === "base64"
                            ? Buffer.from(password).toString("base64")
                            : [...password].map((character) => "%" + character.charCodeAt(0).toString(16)).join("");
                    const suffix = callbackLoginMaterial
                        ? "?marker=" + (callbackLoginMaterial === "plain" ? password : encoded)
                        : "";
                    return redirect(res, appOrigin + "/callback" + suffix, redirectStatus);
                }
                return res.writeHead(403).end();
            }
            html(
                res,
                (parallelStyles
                    ? Array.from({ length: 100 }, (_, i) => `<link rel="stylesheet" href="/style-${i}.css">`).join("")
                    : "") +
                    (manyStyles
                        ? Array.from(
                              { length: 55 },
                              (_, i) =>
                                  `<script>document.write('<link rel="stylesheet" href="/style-${i}.css">')</script>`,
                          ).join("")
                        : "") +
                    '<form method="post" action="/submit"><label>Account<input name="user"></label>' +
                    '<label>Password<input name="password" type="password"></label>' +
                    (unrelatedRead ? "<button disabled>Sign in</button>" : "<button>Sign in</button>") +
                    "</form>" +
                    (unrelatedRead
                        ? "<script>document.querySelector('[type=password]').addEventListener('input', () => " +
                          "{ const picture = new Image(); picture.onload = picture.onerror = () => " +
                          "{ document.querySelector('button').disabled = false }; picture.src = '/unrelated' });" +
                          "</script>"
                        : ""),
            );
        });
        idpOrigin = "https://localhost:" + (await listen(idp));
        browserServer = await chromium.launchServer({
            ...(process.env.VERIQ_TEST_CHROMIUM ? { executablePath: process.env.VERIQ_TEST_CHROMIUM } : {}),
            args: ["--ignore-certificate-errors-spki-list=" + fingerprint],
            host: "127.0.0.1",
        });
        browser = await chromium.connect(browserServer.wsEndpoint());
    } finally {
        rmSync(certDir, { recursive: true, force: true });
    }
});

afterAll(async () => {
    await browser?.close();
    await browserServer?.close();
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

/**
 * 每个辅助调用重新创建浏览器 Context，允许用例观察认证阶段并通过同一 Context 验证后续请求，确保报告与网络一致。
 */
async function attempt({
    identities = ["tester"],
    loginPassword = password,
    stages,
    observation,
    afterLogin,
    configureContext,
    apiOrigin = appOrigin,
}: {
    configureContext?: (context: BrowserContext) => void;
    apiOrigin?: string;
    identities?: string[];
    loginPassword?: string;
    stages?: BrowserSsoResultV1["stage"][];
    observation?: ReturnType<typeof createSsoObservation>;
    afterLogin?: (page: Page) => Promise<void>;
} = {}) {
    const browserContext = await browser.newContext({ serviceWorkers: "block", acceptDownloads: false });
    try {
        configureContext?.(browserContext);
        observation?.attach(browserContext);
        observation?.stage("START");
        const page = await browserContext.newPage();
        const adapterId = randomUUID(),
            workspaceId = randomUUID(),
            secretVersionId = randomUUID();
        const configuration = {
            kind: "BROWSER_SSO",
            entryPath: "/protected",
            idpOrigin,
            idpLoginPath: "/login",
            idpSubmitPath: "/submit",
            callbackPath: "/callback",
            identityPath: "/me",
            identityPointer: "/identity",
            usernameLabel: "Account",
            passwordLabel: "Password",
            submitName: "Sign in",
        } satisfies BrowserSsoAuthConfigV1;
        const role = {
            roleKey: "editor",
            authAdapterVersionId: adapterId,
            secretRef: "test-credential",
            secretVersionId,
            allowedIdentityIds: identities,
        };
        const execution = {
            schemaVersion: "1.0",
            workspaceId,
            runId: randomUUID(),
            caseExecutionId: randomUUID(),
            assetSourceHash: "0".repeat(64),
            environmentVersionId: randomUUID(),
            namespace: "example",
            caseVersionId: randomUUID(),
            attemptNo: 1,
            variables: {},
            browser: "chromium",
            roleKey: role.roleKey,
            secretVersions: [{ secretRef: role.secretRef, versionId: secretVersionId }],
            authAdapters: [
                {
                    workspaceId,
                    versionId: adapterId,
                    contentHash: createHash("sha256").update(canonicalBytes(configuration)).digest("hex"),
                    configuration,
                },
            ],
            environment: {
                schemaVersion: "1.0",
                baseURL: appOrigin,
                apiBaseURL: apiOrigin,
                allowedOrigins: [appOrigin, idpOrigin, ...(apiOrigin === appOrigin ? [] : [apiOrigin])],
                locale: "en-US",
                timezone: "UTC",
                roles: [role],
            },
        } satisfies ExecutionSnapshotV1;
        const auth = await authenticateBusiness({
            page,
            execution,
            signal: AbortSignal.timeout(6000),
            credentials: {
                resolve: async () => {
                    observation?.stage("SUBMISSION_PREPARED");
                    return { username: "tester", password: loginPassword };
                },
            },
            onSsoStage(stage) {
                stages?.push(stage);
                observation?.stage(stage);
            },
            ...(observation ? { onSsoOriginDenied: observation.denied } : {}),
        });
        observation?.stage("AUTHENTICATED");
        await expect(page.locator("main").textContent()).resolves.toBe("Business page");
        await afterLogin?.(page);
        await auth.dispose();
        return auth.identityId;
    } finally {
        observation?.dispose();
        await browserContext.close();
    }
}

test("opens a fresh SSO login and verifies the application session in every attempt", async () => {
    received.length = 0;
    redirectStatus = 303;
    denyEntry = false;
    await expect(attempt()).resolves.toBe("tester");
    await expect(attempt()).resolves.toBe("tester");
    expect(received.filter((r) => r.station === "IDP" && r.method === "POST")).toHaveLength(2);
    expect(received.filter((r) => r.path === "/callback" && r.method === "GET")).toHaveLength(2);
    expect(received.filter((r) => r.path === "/me" && r.method === "GET")).toHaveLength(2);
});

test.each([307, 308])("blocks an IdP form replay before a %d reaches the callback", async (status) => {
    received.length = 0;
    redirectStatus = status;
    denyEntry = false;
    await expect(attempt()).rejects.toThrow("SSO_ORIGIN_NOT_ALLOWED");
    expect(received.filter((r) => r.station === "IDP" && r.method === "POST")).toHaveLength(1);
    expect(received.filter((r) => r.path === "/callback")).toHaveLength(0);
    expect(received.filter((r) => r.path === "/me")).toHaveLength(0);
});

test("blocks an undeclared redirect before the receiving server gets a request", async () => {
    received.length = 0;
    denyEntry = true;
    await expect(attempt()).rejects.toThrow("SSO_ORIGIN_NOT_ALLOWED");
    expect(received.filter((r) => r.station !== "APP")).toHaveLength(0);
    expect(received.filter((r) => r.path === "/me")).toHaveLength(0);
});

test("classifies a rejected login at the IdP and never verifies an application session", async () => {
    received.length = 0;
    denyEntry = false;
    const stages: BrowserSsoResultV1["stage"][] = [];
    await expect(attempt({ loginPassword: randomUUID(), stages })).rejects.toThrow("SSO_AUTHENTICATION_FAILED");
    expect(stages).toEqual(["IDP"]);
    expect(received.filter((r) => r.path === "/callback" || r.path === "/me")).toHaveLength(0);
});

test("requires the browser session to identify an explicitly allowed account", async () => {
    received.length = 0;
    redirectStatus = 303;
    denyEntry = false;
    const stages: BrowserSsoResultV1["stage"][] = [];
    await expect(attempt({ identities: ["another-user"], stages })).rejects.toThrow("IDENTITY_NOT_ALLOWED");
    expect(stages).toEqual(["IDP", "CALLBACK", "IDENTITY"]);
    expect(received.filter((r) => r.path === "/me")).toHaveLength(1);
});

test("blocks identity-provider traffic after the application session is approved", async () => {
    received.length = 0;
    redirectStatus = 303;
    denyEntry = false;
    await attempt({
        async afterLogin(page) {
            const initial = received.filter((r) => r.station === "IDP").length;
            await expect(page.goto(idpOrigin + "/business-never-calls-idp", { timeout: 4000 })).rejects.toThrow();
            expect(received.filter((r) => r.station === "IDP")).toHaveLength(initial);
        },
    });
});

test("keeps the pinned identity navigation from following redirects even on the application origin", async () => {
    received.length = 0;
    redirectStatus = 303;
    denyEntry = false;
    redirectIdentity = true;
    try {
        await expect(attempt()).rejects.toThrow("SSO_ORIGIN_NOT_ALLOWED");
        expect(received.filter((r) => r.path === "/me")).toHaveLength(1);
        expect(received.filter((r) => r.path === "/identity-redirect")).toHaveLength(0);
    } finally {
        redirectIdentity = false;
    }
});

test("blocks an unrelated IdP read triggered while the password field is being filled", async () => {
    received.length = 0;
    redirectStatus = 303;
    denyEntry = false;
    unrelatedRead = true;
    try {
        const result = await attempt().catch((error: unknown) => error);
        expect(received.filter((r) => r.path === "/unrelated" || r.path === "/callback")).toHaveLength(0);
        expect(result).toMatchObject({ message: "SSO_ORIGIN_NOT_ALLOWED" });
    } finally {
        unrelatedRead = false;
    }
});

test.each(["plain", "percent", "base64"] as const)(
    "does not send a callback carrying %s login material to the business server",
    async (encoding) => {
        received.length = 0;
        redirectStatus = 303;
        denyEntry = false;
        callbackLoginMaterial = encoding;
        try {
            const result = await attempt().catch((error: unknown) => error);
            expect(received.filter((r) => r.station === "IDP" && r.method === "POST")).toHaveLength(1);
            expect(received.filter((r) => r.path === "/callback" || r.path === "/me")).toHaveLength(0);
            expect(result).toMatchObject({ message: "SSO_ORIGIN_NOT_ALLOWED" });
        } finally {
            callbackLoginMaterial = undefined;
        }
    },
);

test.each(["gzip", "br"] as const)(
    "keeps %s document bytes, scripts, and repeated HttpOnly cookies",
    async (encoding) => {
        redirectStatus = 303;
        denyEntry = false;
        const observation = createSsoObservation(appOrigin, idpOrigin);
        onTestFailed(() => {
            console.error(observation.report());
        });
        documentEncoding = encoding;
        try {
            await expect(
                attempt({
                    observation,
                    async afterLogin(page) {
                        const cookies = await page.context().cookies(appOrigin);
                        expect(
                            cookies
                                .filter((cookie) => cookie.httpOnly)
                                .map((cookie) => cookie.name)
                                .sort(),
                        ).toEqual(["business", "documentA", "documentB"]);
                        const response = await page.reload();
                        expect(await response?.headerValue("content-security-policy")).toContain("script-src 'self'");
                        expect(await response?.headerValue("connection-allowlist")).toContain("webrtc=block");
                    },
                }),
            ).resolves.toBe("tester");
        } finally {
            documentEncoding = undefined;
        }
    },
);

test("fails closed if an application response already has a different native egress policy", async () => {
    redirectStatus = 303;
    denyEntry = false;
    conflictingNativePolicy = true;
    try {
        await expect(attempt()).rejects.toThrow("SSO_ORIGIN_NOT_ALLOWED");
    } finally {
        conflictingNativePolicy = false;
    }
});

test.each(["stun", "quic"] as const)("keeps native %s packets off the network after SSO", async (kind) => {
    redirectStatus = 303;
    denyEntry = false;
    const socket = createSocket("udp4");
    let packets = 0;
    const receivedPacket = new Promise<void>((resolve) => {
        socket.on("message", () => {
            packets++;
            resolve();
        });
    });
    try {
        await new Promise<void>((resolve, reject) => {
            socket.once("error", reject);
            socket.bind(0, "127.0.0.1", resolve);
        });
        await attempt({
            async afterLogin(page) {
                // 夹具只监听本机端口；等待首个 UDP 包、浏览器拒绝 WebTransport 或预先限制的静默窗口。
                const observation = page.evaluate(
                    async ({ kind, port }) => {
                        if (kind === "quic") {
                            try {
                                const transport = new WebTransport("https://127.0.0.1:" + port + "/veriq-probe");
                                await transport.ready;
                                transport.close();
                                return "connected";
                            } catch (error) {
                                return error instanceof Error ? error.name : "rejected";
                            }
                        }
                        const peer = new RTCPeerConnection({ iceServers: [{ urls: "stun:127.0.0.1:" + port }] });
                        try {
                            peer.createDataChannel("probe");
                            await peer.setLocalDescription(await peer.createOffer());
                            if (peer.iceGatheringState !== "complete") {
                                await new Promise<void>((resolve) => {
                                    peer.addEventListener("icegatheringstatechange", () => {
                                        if (peer.iceGatheringState === "complete") resolve();
                                    });
                                });
                            }
                            return "complete";
                        } finally {
                            peer.close();
                        }
                    },
                    { kind, port: socket.address().port },
                );
                const deadline = AbortSignal.timeout(1800);
                const result = await Promise.race([
                    observation,
                    receivedPacket.then(() => "wire packet"),
                    new Promise<string>((resolve) => {
                        deadline.addEventListener("abort", () => resolve("quiet"), { once: true });
                    }),
                ]);
                expect(packets).toBe(0);
                if (kind === "quic") expect(result).toBe("WebTransportError");
                else expect(["complete", "quiet"]).toContain(result);
            },
        });
    } finally {
        await new Promise<void>((resolve) => socket.close(resolve));
    }
});

test("loads the gzip landing script before the guard receives the committed frame notification", async () => {
    documentEncoding = "gzip";
    redirectStatus = 303;
    denyEntry = false;
    let decided = false;
    let delivered = false;
    try {
        await attempt({
            configureContext(context) {
                const connect = context.newCDPSession.bind(context);
                context.newCDPSession = async (page) => {
                    const session = await connect(page);
                    const emitter = session as unknown as { emit(name: string, ...args: unknown[]): boolean };
                    const emit = emitter.emit.bind(session);
                    const send = session.send.bind(session);
                    let release: (() => void) | undefined;
                    let script: string | undefined;
                    session.on("Fetch.requestPaused", (event) => {
                        if (!decided && event.request.url === appOrigin + "/demo.js") script = event.requestId;
                    });
                    emitter.emit = (name, ...args) => {
                        const frame = (args[0] as { frame?: { url: string } })?.frame;
                        if (name !== "Page.frameNavigated" || delivered || frame?.url !== appOrigin + "/protected")
                            return emit(name, ...args);
                        const notify = () => {
                            delivered = true;
                            emit(name, ...args);
                        };
                        if (decided) notify();
                        else release = notify;
                        return true;
                    };
                    session.send = (method, params) => {
                        const result = send(method, params);
                        if (
                            (method === "Fetch.continueRequest" || method === "Fetch.failRequest") &&
                            script &&
                            (params as { requestId?: string })?.requestId === script
                        ) {
                            decided = true;
                            release?.();
                            release = undefined;
                        }
                        return result;
                    };
                    return session;
                };
            },
        });
        expect(decided && delivered).toBe(true);
    } finally {
        documentEncoding = undefined;
    }
});

test("verifies the configured identity document on a separate authorized API origin", async () => {
    redirectStatus = 303;
    denyEntry = false;
    await expect(attempt({ apiOrigin: identityOrigin })).resolves.toBe("tester");
});

test("completes authentication after 55 sequential same-origin login stylesheets", async () => {
    received.length = 0;
    manyStyles = true;
    redirectStatus = 303;
    denyEntry = false;
    try {
        await expect(attempt()).resolves.toBe("tester");
        const submit = received.findIndex((r) => r.path === "/submit");
        expect(
            received.slice(0, submit).filter((r) => r.station === "IDP" && r.path.startsWith("/style-")),
        ).toHaveLength(55);
    } finally {
        manyStyles = false;
    }
});

test.each(["sync", "microtask", "timer"] as const)(
    "accepts the committed callback document navigating via %s",
    async (mode) => {
        received.length = 0;
        callbackPage = mode;
        redirectStatus = 303;
        denyEntry = false;
        try {
            await expect(attempt()).resolves.toBe("tester");
            const paths = received.filter((r) => r.station === "APP").map((r) => r.path);
            const script = paths.indexOf("/callback-script.js");
            const landing = paths.indexOf("/protected", script + 1);
            expect(script).toBeGreaterThan(paths.indexOf("/callback"));
            expect(landing).toBeGreaterThan(script);
            expect(paths.indexOf("/me")).toBeGreaterThan(landing);
        } finally {
            callbackPage = undefined;
            releaseParser?.();
            releaseParser = undefined;
        }
    },
);

test("completes authentication with 100 independent login stylesheets discovered together", async () => {
    received.length = 0;
    parallelStyles = true;
    redirectStatus = 303;
    denyEntry = false;
    let release!: () => void;
    stylesPending = new Promise<void>((resolve) => {
        release = resolve;
    });
    const seen = new Set<string>();
    try {
        await expect(
            attempt({
                configureContext(context) {
                    const connect = context.newCDPSession.bind(context);
                    context.newCDPSession = async (target) => {
                        const session = await connect(target);
                        session.on("Network.requestWillBeSent", (event) => {
                            if (
                                event.type === "Stylesheet" &&
                                new URL(event.request.url).pathname.startsWith("/style-")
                            )
                                seen.add(event.requestId);
                            if (seen.size === 100) release();
                        });
                        await session.send("Network.enable");
                        return session;
                    };
                },
            }),
        ).resolves.toBe("tester");
        expect(seen.size).toBe(100);
        const submit = received.findIndex((r) => r.path === "/submit");
        expect(
            received.slice(0, submit).filter((r) => r.station === "IDP" && r.path.startsWith("/style-")),
        ).toHaveLength(100);
    } finally {
        release();
        stylesPending = undefined;
        parallelStyles = false;
    }
});

test.each([13, 14])("retains the sixteen-document redirect ceiling with %i extra redirects", async (hops) => {
    redirectHops = hops;
    redirectStatus = 303;
    denyEntry = false;
    try {
        if (hops === 13) await expect(attempt()).resolves.toBe("tester");
        else await expect(attempt()).rejects.toThrow("SSO_ORIGIN_NOT_ALLOWED");
    } finally {
        redirectHops = 0;
    }
});

test("retains callback-page refresh and the final application-origin requirement", async () => {
    redirectStatus = 303;
    denyEntry = false;
    try {
        callbackPage = "meta";
        const observation = createSsoObservation(appOrigin, idpOrigin);
        onTestFailed(() => {
            console.error(observation.report());
        });
        await expect(attempt({ observation })).resolves.toBe("tester");
        callbackPage = "api";
        received.length = 0;
        await expect(attempt({ apiOrigin: identityOrigin })).rejects.toThrow();
        expect(received.some((r) => r.path === "/api-landing")).toBe(true);
        expect(received.some((r) => r.path === "/me")).toBe(false);
    } finally {
        callbackPage = undefined;
    }
});

test("continues a business session after repeated superseded top-level read navigations", async () => {
    redirectStatus = 303;
    denyEntry = false;
    try {
        await attempt({
            async afterLogin(page) {
                for (let n = 0; n < 10; n++) {
                    const arrived = new Promise<void>((resolve) => {
                        receivedSlow = resolve;
                    });
                    const reading = page.goto(appOrigin + "/held-business").then(
                        () => true,
                        () => false,
                    );
                    await Promise.race([
                        arrived,
                        reading.then(() => {
                            throw new Error("BUSINESS_REQUEST_DID_NOT_REACH_FIXTURE");
                        }),
                    ]);
                    const fresh = await page.goto(appOrigin + "/protected", { waitUntil: "domcontentloaded" });
                    expect(fresh?.ok()).toBe(true);
                    await expect(reading).resolves.toBe(false);
                }
            },
        });
    } finally {
        receivedSlow = undefined;
    }
});
