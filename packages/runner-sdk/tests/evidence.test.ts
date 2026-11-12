import { test, expect } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fixture } from "./helpers.js";
test("actual raw Trace/screenshots remain restricted while ordinary events redact credentials and headers", async () => {
    const { EvidencePolicy } = await import("../src/evidence.js");
    const f = await fixture(),
        directory = await mkdtemp(join(tmpdir(), "veriq-evidence-"));
    const secret = "synthetic-protected-evidence-credential";
    const policy = new EvidencePolicy();
    policy.protect({ password: secret });
    try {
        await f.page
            .context()
            .tracing.start({ screenshots: true, snapshots: true, sources: true });
        await f.page.context().setExtraHTTPHeaders({
            authorization: `Bearer ${secret}`,
            cookie: `demo=${secret}`,
        });
        await f.page.getByTestId("name").fill(secret);
        await f.page.getByTestId("save").click();
        const screenshot = await policy.screenshot(f.page, directory);
        const trace = await policy.stopTrace(f.page.context(), directory);
        expect((await stat(screenshot.path)).size).toBeGreaterThan(100);
        const archive = await promisify(execFile)("python", [
            "-c",
            "import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); print(any(sys.argv[2].encode() in z.read(n) for n in z.namelist()))",
            trace.path,
            secret,
        ]);
        expect(archive.stdout.trim()).toBe("True"); // proves raw Playwright Trace really contains protected data
        expect(() => policy.access(trace, { credentialEvidence: false })).toThrow(
            "CREDENTIAL_EVIDENCE_FORBIDDEN",
        );
        expect(policy.access(trace, { credentialEvidence: true }).path).toBe(
            trace.path,
        );
        const projected = policy.redact({
            headers: {
                Authorization: "unregistered",
                cookie: "another",
                "set-cookie": "other",
            },
            message: secret,
            events: [
                { kind: "dialog", message: secret, promptText: secret },
                {
                    kind: "download",
                    path: "/restricted/file",
                    suggestedFilename: secret,
                    sensitivity: "CREDENTIAL_RESTRICTED",
                },
            ],
            trace,
        } as never);
        const text = JSON.stringify(projected);
        expect(text).not.toContain(secret);
        expect(text).not.toContain("unregistered");
        expect(text).not.toContain(trace.path);
        expect(text).not.toContain("/restricted/file");
        expect(text).toContain("CREDENTIAL_RESTRICTED");
    } finally {
        await f.close();
        await rm(directory, { recursive: true, force: true });
    }
});
test("real downloaded bytes and hostile suggested names are restricted without altering useful raw evidence", async () => {
    const { createServer } = await import("node:http");
    const { EvidencePolicy } = await import("../src/evidence.js");
    const { createStepContext } = await import("../src/context.js");
    const { executeStep } = await import("../src/execute-step.js");
    const { step } = await import("./helpers.js");
    const secret = "synthetic-download-credential";
    const policy = new EvidencePolicy();
    policy.protect(secret);
    const target = createServer((req, res) => {
        if (req.url === "/file") {
            res.writeHead(200, {
                "Content-Disposition": `attachment; filename="../${secret}.txt"`,
                "Content-Type": "application/octet-stream",
            });
            res.end(secret);
        } else {
            res.setHeader("content-type", "text/html");
            res.end('<a data-testid="download" href="/file">Download</a>');
        }
    });
    await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
    const origin = `http://127.0.0.1:${(target.address() as { port: number }).port}`;
    const f = await fixture(),
        directory = await mkdtemp(join(tmpdir(), "veriq-download-"));
    try {
        await f.page.goto(origin);
        const ctx = createStepContext({
            ...f.options,
            environment: {
                ...f.options.environment,
                baseURL: origin,
                apiBaseURL: origin,
                allowedOrigins: [origin],
            },
            catalog: {
                schemaVersion: "1.0",
                elements: [
                    { key: "download", locator: { by: "testId", value: "download" } },
                ],
            },
            downloads: { directory, maxBytes: 1024 },
        });
        try {
            const result = await executeStep(
                step({
                    id: "download",
                    action: "click",
                    target: "download",
                    observers: [{ id: "file", kind: "download" }],
                }),
                ctx,
            );
            expect(result.status).toBe("PASSED");
            const evidence = result.events[0]!;
            expect(evidence).toMatchObject({
                kind: "download",
                sensitivity: "CREDENTIAL_RESTRICTED",
            });
            if (evidence.kind !== "download") throw Error();
            expect(await readFile(evidence.path!, "utf8")).toBe(secret);
            expect(JSON.stringify(policy.redact(result as never))).not.toContain(
                secret,
            );
            expect(JSON.stringify(policy.redact(result as never))).not.toContain(
                directory,
            );
            const { snapshot, id, rehash } =
                await import("../../compiler/tests/helpers.js");
            const { analyze } = await import("../../compiler/src/index.js");
            const { executeCase } = await import("../src/register-case.js");
            const source = snapshot([
                {
                    id: "download",
                    action: "click",
                    target: "download",
                    observers: [{ id: "file", kind: "download" }],
                },
            ]);
            const catalog = source.assets.find((a) => a.kind === "ELEMENT_CATALOG")!;
            if (catalog.kind !== "ELEMENT_CATALOG") throw Error();
            catalog.document.elements = [
                { key: "download", locator: { by: "testId", value: "download" } },
            ];
            rehash(source);
            const captured: unknown[] = [];
            const report = await executeCase(analyze(source).cases[0]!, source, {
                page: f.page,
                execution: {
                    schemaVersion: "1.0",
                    workspaceId: source.workspaceId,
                    runId: id(10),
                    caseExecutionId: id(11),
                    caseVersionId: id(1),
                    assetSourceHash: source.sourceHash,
                    environmentVersionId: id(12),
                    environment: {
                        ...ctx.environment,
                        roles: [
                            {
                                roleKey: "reader",
                                authAdapterVersionId: id(13),
                                secretRef: "reader",
                                secretVersionId: id(14),
                            },
                        ],
                    },
                    roleKey: "reader",
                    browser: "chromium",
                    variables: {},
                    secretVersions: [{ secretRef: "reader", versionId: id(14) }],
                    namespace: "evidence",
                    attemptNo: 1,
                },
                lifecycle: { authenticate: async () => ({ identityId: "reader" }) },
                downloads: { directory, maxBytes: 1024 },
                restrictedEvidence: async (evidence) => {
                    captured.push(evidence);
                },
            });
            expect(report.outcome).toBe("PASSED");
            expect(captured).toHaveLength(1);
            expect(captured[0]).toMatchObject({
                kind: "DOWNLOAD",
                sensitivity: "CREDENTIAL_RESTRICTED",
            });
            expect(JSON.stringify(report)).not.toContain(directory);
        } finally {
            ctx.dispose();
        }
    } finally {
        await f.close();
        target.closeAllConnections();
        await new Promise<void>((r) => target.close(() => r()));
        await rm(directory, { recursive: true, force: true });
    }
});
