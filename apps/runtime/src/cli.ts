#!/usr/bin/env node

/**
 * 本文件是开发期 veriq_cli 入口：编排注册、认领、离线包与信任根命令：密钥经 pino redact 永不写入日志或 URL（cli）。
 */
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { runOffline, recoverOffline } from "./offline/run.ts";
import { LocalStore } from "./offline/store.ts";
import { LocalReports } from "./offline/reports.ts";
import { uploadOffline } from "./offline/upload.ts";
import { updatePrivate, readPrivate } from "./offline/config.ts";
import { TrustStore, type IssuerTrust } from "./offline/trust.ts";
import { verifyBundle } from "./offline/verify.ts";
import { downloadBundle } from "./offline/download.ts";
import { SecretStore, type SecretReference } from "./credentials/store.ts";
import { managedFileCredentials } from "./credentials/restricted-file.ts";
import type { CredentialOptions } from "./credentials/profile.ts";
import { installedCredentials } from "./credentials/host.ts";
import { openTrace } from "./trace.ts";
/** CLI 在独立角色入口校验完整发行库存，凭据模式只由受信任启动参数选择；源码入口的完整库存接入仍单独验证，业务参数不得指定保险库辅助程序或把后端失败解释为明文授权。 */
import { Command } from "commander";
import pino from "pino";
import { join, dirname, basename } from "node:path";
import { loadRuntimeDistribution, assertRuntimeRole, diagnoseRelease } from "./distribution.ts";
import { spawn } from "node:child_process";
import { DeviceSession } from "./agent/credentials.ts";
import { AgentClient } from "./agent/transport.ts";
import { claimLoop } from "./agent/claim-loop.ts";
import { agentControl, serveAgentControl } from "./agent/control.ts";
import { ExecutionSupervisor } from "./execution/supervisor.ts";
import { hostname } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { DeviceStore, RuntimeClient, RuntimeError } from "./enrollment.ts";
import { doctor } from "./doctor.ts";

const logger = pino(
    {
        name: "veriq_cli",
        redact: {
            paths: ["token", "deviceToken", "deviceCode", "authorization"],
            censor: "[REDACTED]",
        },
    },
    pino.destination(2),
);
const entryRole = basename(process.execPath).replace(/\.exe$/i, "");
const entryDistribution = ["veriq_cli", "veriq_agent"].includes(entryRole)
    ? await loadRuntimeDistribution(dirname(dirname(dirname(process.execPath))))
    : undefined;
if (entryDistribution)
    assertRuntimeRole(entryDistribution, entryRole === "veriq_agent" ? "agent" : "cli");
let entryCredentials: CredentialOptions | undefined;
const program = new Command()
    .name("veriq_cli")
    .description("VeriQ Runtime enrollment and diagnostics (development)")
    .version(entryDistribution?.productVersion ?? "0.1.0");
program.option("--config-dir <directory>", "Private development configuration directory");
program.option("--distribution-root <directory>", "Installed Runtime distribution root");
program.option(
    "--credential-mode <mode>",
    "Credential backend: os-vault or explicit managed Linux restricted-file",
    "os-vault",
);
program.option(
    "--managed-service-uid <uid>",
    "Exact dedicated nonroot Linux service UID for restricted-file mode",
);
program.option(
    "--persistent-volume <directory>",
    "Existing private external persistent mount containing --config-dir",
);
program.option(
    "--acknowledge-unencrypted-storage",
    "Acknowledge restricted-file provides no encryption at rest",
);
/** 服务文件模式必须由命令行明确选择并完整核验，不能因默认保险库构造失败而落入此分支；选择不改变设备执行位置或控制平台信任等级，未选模式却携带服务参数同样拒绝，避免操作者误以为限制已经生效。 */
program.hook("preAction", async () => {
    const options = program.opts<{
        credentialMode: string;
        managedServiceUid?: string;
        persistentVolume?: string;
        acknowledgeUnencryptedStorage?: boolean;
        configDir?: string;
    }>();
    if (options.credentialMode === "restricted-file") {
        if (
            !options.managedServiceUid ||
            !/^[1-9][0-9]*$/.test(options.managedServiceUid) ||
            !options.configDir ||
            !options.persistentVolume ||
            options.acknowledgeUnencryptedStorage !== true
        )
            throw new Error("RESTRICTED_FILE_CONTEXT_REQUIRED");
        entryCredentials = await managedFileCredentials({
            mode: "restricted-file",
            managedHeadless: true,
            serviceUid: Number(options.managedServiceUid),
            persistentVolume: options.persistentVolume,
            profileDirectory: options.configDir,
            acknowledgeUnencryptedStorage: true,
        });
        process.stderr.write(
            "Credential mode: restricted-file; no encryption at rest. Configured service UID and private mounted volume verified.\n",
        );
    } else {
        if (
            options.credentialMode !== "os-vault" ||
            options.managedServiceUid !== undefined ||
            options.persistentVolume !== undefined ||
            options.acknowledgeUnencryptedStorage !== undefined
        )
            throw new Error("CREDENTIAL_MODE_INVALID");
        if (!entryDistribution && program.getOptionValueSource("credentialMode") === "cli")
            throw new Error("RUNTIME_VAULT_CAPABILITY_UNVERIFIED");
        entryCredentials = entryDistribution ? installedCredentials(entryDistribution) : undefined;
    }
});

/** 原生角色入口从物理可执行文件推导安装根，显式根仅供可信启动器传入且仍校验角色身份；开发 node 入口保持原来的源码探测，缺失安装清单绝不静默回落到开发依赖或系统浏览器。 */
async function installedDistribution() {
    const role = basename(process.execPath).replace(/\.exe$/i, "");
    const root =
        program.opts<{ distributionRoot?: string }>().distributionRoot ??
        (["veriq_cli", "veriq_agent"].includes(role)
            ? dirname(dirname(dirname(process.execPath)))
            : undefined);
    if (!root) return;
    const installed = await loadRuntimeDistribution(root);
    assertRuntimeRole(installed, role === "veriq_agent" ? "agent" : "cli");
    return installed;
}

/** 注册与诊断共享完整发行核验，安装模式只允许清单中钉选的浏览器与引擎；调用者可选择控制 Origin 而不能通过 CLI 参数替换安装执行代码，避免登记出实际无法执行的组件版本。 */
async function nativeDoctor(options: { server?: string; browserExecutable?: string }) {
    const installed = await installedDistribution();
    if (!installed)
        return doctor({
            ...options,
            executablePath: options.browserExecutable,
            signal: controller.signal,
        });
    if (options.browserExecutable && options.browserExecutable !== installed.browserExecutable)
        throw new Error("RUNTIME_CONFIGURATION_MISMATCH");
    return diagnoseRelease({
        ...installed,
        ...(options.server ? { server: options.server } : {}),
        signal: controller.signal,
    });
}

/** 安装 CLI 启动在线服务时必须转交给真实 Agent 角色 Node，而不是只修改当前 CLI 的进程标题；参数按原始数组传递，父进程等待真实退出，并把取消信号传给会执行既有排空协议的 Agent。 */
async function startInstalledAgent(
    installed: NonNullable<Awaited<ReturnType<typeof installedDistribution>>>,
) {
    controller.signal.throwIfAborted();
    const child = spawn(installed.agentExecutable, [installed.cliEntry, ...process.argv.slice(2)], {
        stdio: "inherit",
    });
    const cancel = () => {
        child.kill("SIGTERM");
    };
    controller.signal.addEventListener("abort", cancel, { once: true });
    try {
        process.exitCode = await new Promise<number>((resolve, reject) => {
            child.once("error", reject);
            child.once("exit", (code) => resolve(code ?? 1));
        });
    } finally {
        controller.signal.removeEventListener("abort", cancel);
    }
}
const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());
program
    .command("trace")
    .description("Privileged local evidence viewer")
    .command("open <file>")
    .description("Open a downloaded Trace locally using pinned Playwright")
    .action((file: string) => openTrace(file, controller.signal));
const store = () =>
    new DeviceStore(program.opts<{ configDir?: string }>().configDir, entryCredentials);
const common = (command: Command) =>
    command.option(
        "--browser-executable <path>",
        "Explicit test browser executable (otherwise Playwright installation)",
    );
common(
    program
        .command("doctor")
        .description("Inspect Node, engine/SDK, browser launch and optional control network")
        .option("--server <origin>", "Control service origin"),
).action(async (options: { server?: string; browserExecutable?: string }) => {
    const result = await nativeDoctor(options);
    for (const c of result.checks)
        process.stdout.write(`${c.ok ? "PASS" : "FAIL"} ${c.name}: ${c.detail}\n`);
    process.exitCode = result.ok ? 0 : 1;
});
common(
    program
        .command("login")
        .description("Enroll this device with browser owner approval")
        .requiredOption("--server <origin>", "HTTPS control service origin")
        .option("--name <name>", "Device display name", hostname()),
).action(async (options: { server: string; name: string; browserExecutable?: string }) => {
    const deviceStore = store();
    try {
        await deviceStore.load();
        throw new Error("ALREADY_ENROLLED");
    } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    const client = new RuntimeClient(options.server);
    const diagnostics = await nativeDoctor(options);
    if (!diagnostics.ok || !diagnostics.capabilities) throw new Error("DOCTOR_FAILED");
    const enrollment = await client.begin(
        options.name,
        diagnostics.capabilities,
        controller.signal,
    );
    process.stdout.write(
        `Open ${enrollment.verificationUrl}\nApproval code: ${enrollment.userCode}\nConfirm the device, Workspace and sharing scope.\n`,
    );
    while (Date.now() < Date.parse(enrollment.expiresAt)) {
        await delay(Math.max(5, enrollment.intervalSeconds) * 1000, undefined, {
            signal: controller.signal,
        });
        try {
            const receipt = await client.poll(enrollment.deviceCode, controller.signal);
            await deviceStore.save({ server: client.server, ...receipt });
            process.stdout.write(
                `Registered ${receipt.runnerId} in Workspace ${receipt.workspaceId}. Worker is offline.\n`,
            );
            return;
        } catch (error) {
            if (!(error instanceof RuntimeError && error.code === "ENROLLMENT_PENDING"))
                throw error;
        }
    }
    throw new Error("ENROLLMENT_EXPIRED");
});
common(
    program
        .command("enroll-service")
        .description("Register a cloud Runtime; read one-time deployment token from stdin")
        .requiredOption("--server <origin>", "HTTPS control origin")
        .option("--name <name>", "Device name", hostname())
        .option("--share-workspace", "Explicitly consent to Workspace sharing", false),
).action(
    async (options: {
        server: string;
        name: string;
        shareWorkspace: boolean;
        browserExecutable?: string;
    }) => {
        const deviceStore = store();
        try {
            await deviceStore.load();
            throw new Error("ALREADY_ENROLLED");
        } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
                throw error;
        }
        const client = new RuntimeClient(options.server);
        const diagnostics = await nativeDoctor(options);
        if (!diagnostics.ok || !diagnostics.capabilities) throw new Error("DOCTOR_FAILED");
        let secret = "";
        const timeout = setTimeout(() => process.stdin.destroy(new Error("INPUT_TIMEOUT")), 30_000);
        try {
            for await (const chunk of process.stdin) {
                secret += String(chunk);
                if (secret.length > 128) throw new Error("INVALID_TOKEN_INPUT");
            }
        } finally {
            clearTimeout(timeout);
        }
        secret = secret.trim();
        if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) throw new Error("INVALID_TOKEN_INPUT");
        const receipt = await client.serviceEnroll(
            options.name,
            diagnostics.capabilities,
            secret,
            options.shareWorkspace,
            controller.signal,
        );
        await store().save({ server: client.server, ...receipt });
        process.stdout.write(
            `Registered ${receipt.runnerId}. Worker is offline; trust requires administrator approval.\n`,
        );
    },
);
program
    .command("logout")
    .description("Revoke the current device token and remove local configuration")
    .option("--local-only", "Forget only the local device credential without remote revocation")
    .action(async (options: { localOnly?: boolean }) => {
        const s = store();
        await s.ensureStopped();
        if (options.localOnly) {
            await s.remove();
            await new SecretStore(s.directory, entryCredentials).clear();
            process.stdout.write(
                "Local device credential removed. Remote revocation was not attempted. The server credential may still be valid; revoke the device in the Web console or wait for expiry.\n",
            );
            return;
        }
        let config = await s.load();
        if (await s.hasPendingRotation()) config = await s.renew(new RuntimeClient(config.server));
        let alreadyRejected = false;
        try {
            await new RuntimeClient(config.server).logout(config.deviceToken, controller.signal);
        } catch (error) {
            if (
                !(
                    error instanceof RuntimeError &&
                    error.status === 401 &&
                    ["DEVICE_UNAUTHORIZED", "DEVICE_REVOKED"].includes(error.code)
                )
            )
                throw error;
            alreadyRejected = true;
        }
        await s.remove();
        await new SecretStore(s.directory, entryCredentials).clear();
        process.stdout.write(
            alreadyRejected
                ? "Server already rejected this device credential; local credential removed. You can enroll again. Revoke the device in the Web console if you also need to prevent future reuse.\n"
                : "Device credential revoked and local configuration removed.\n",
        );
    });
const workspace = program
    .command("workspace")
    .description("Inspect or select an existing approved device binding");
workspace.command("list").action(async () => {
    const config = await store().load();
    const info = await new RuntimeClient(config.server).inspectDevice(
        config.deviceToken,
        controller.signal,
    );
    process.stdout.write(`${info.workspaceId}\n`);
});
workspace.command("use <workspace-id>").action(async (id: string) => {
    const config = await store().load();
    const info = await new RuntimeClient(config.server).inspectDevice(
        config.deviceToken,
        controller.signal,
    );
    if (info.workspaceId !== id) throw new Error("WORKSPACE_NOT_BOUND");
    process.stdout.write(`Using approved Workspace ${id}.\n`);
});
program
    .command("status")
    .description("Inspect registration and current authorization; does not start a worker")
    .action(async () => {
        const config = await store().load();
        const info = await new RuntimeClient(config.server).inspectDevice(
            config.deviceToken,
            controller.signal,
        );
        process.stdout.write(`${info.name}: ${info.status}; current trust ${info.trustStatus}\n`);
    });
const runtime = program.command("runtime").description("Run and control the online Linux Agent");
runtime
    .command("start")
    .option("--release-dir <path>", "Operator-approved fixed engine release directory")
    .option("--browser-executable <path>", "Pinned Playwright browser executable")
    .option("--once", "Process at most one claim, then stop")
    .action(async (options: { releaseDir: string; browserExecutable: string; once?: boolean }) => {
        if (process.platform !== "linux") throw new Error("UNSUPPORTED_PROCESS_PLATFORM");
        const installed = await installedDistribution();
        if (installed && entryRole !== "veriq_agent") {
            await startInstalledAgent(installed);
            return;
        }
        if (installed) assertRuntimeRole(installed, "agent");
        if (
            installed &&
            ((options.releaseDir && options.releaseDir !== installed.engineDirectory) ||
                (options.browserExecutable &&
                    options.browserExecutable !== installed.browserExecutable))
        )
            throw new Error("RUNTIME_CONFIGURATION_MISMATCH");
        const releaseDirectory = installed?.engineDirectory ?? options.releaseDir;
        const browserExecutable = installed?.browserExecutable ?? options.browserExecutable;
        if (!releaseDirectory || !browserExecutable)
            throw new Error("RUNTIME_CONFIGURATION_REQUIRED");
        const diagnostics = await diagnoseRelease({
            engineDirectory: releaseDirectory,
            engineVersion: installed?.engineVersion ?? "1.0.0",
            browserExecutable,
            signal: controller.signal,
        });
        if (!diagnostics.ok || !diagnostics.capabilities) throw new Error("DOCTOR_FAILED");
        process.title = "veriq_agent";
        const profile = store(),
            config = await profile.load(),
            client = new RuntimeClient(config.server);
        const session = new DeviceSession(profile, client);
        await session.open();
        const root = join(profile.directory, "agent");
        let close: (() => Promise<void>) | undefined;
        try {
            close = await serveAgentControl(root, () => controller.abort());
            const transport = new AgentClient(session);
            const info =
                await transport.request<
                    import("@veriq/contracts").PlatformComponents["schemas"]["RuntimeDTO"]
                >("/internal/v1/runtime");
            if (info.capabilities.engineVersion !== diagnostics.capabilities.engineVersion)
                throw new Error("RUNTIME_CAPABILITY_MISMATCH_REENROLL");
            const supervisor = new ExecutionSupervisor({
                root,
                client: transport,
                releaseDirectory,
                browserExecutable,
                ...(installed ? { execution: installed.execution } : {}),
            });
            await claimLoop({
                client: transport,
                supervisor,
                root,
                runnerId: config.runnerId,
                capabilities: diagnostics.capabilities,
                signal: controller.signal,
                ...(options.once ? { once: true } : {}),
            });
        } finally {
            await close?.();
            await session.close();
        }
    });
runtime.command("status").action(async () => {
    const result = await agentControl(join(store().directory, "agent"), "status");
    process.stdout.write(`Agent running: ${result.running}; PID ${result.pid}\n`);
});
runtime.command("stop").action(async () => {
    await agentControl(join(store().directory, "agent"), "stop");
    process.stdout.write(
        "Agent stop requested; active Attempt cleanup and process confirmation precede shutdown.\n",
    );
});
const bundle = program.command("bundle").description("Download and verify signed offline data");
bundle
    .command("download <bundle-id>")
    .requiredOption("--output <path>", "New archive file")
    .action(async (id: string, options: { output: string }) => {
        await downloadBundle(await store().load(), id, options.output, controller.signal);
        process.stdout.write("Bundle downloaded; verify before opening.\n");
    });
bundle
    .command("verify <file>")
    .requiredOption("--destination <directory>", "New read-only snapshot directory")
    .option("--debug", "Explicitly accept expired/unvalidated data; excludes formal gates")
    .action(async (file: string, options: { destination: string; debug?: boolean }) => {
        const result = await verifyBundle(file, {
            trust: new TrustStore(store().directory),
            ...options,
        });
        process.stdout.write(
            `Verified ${result.manifest.bundleId}; revocation UNKNOWN; mode ${result.debug ? "DEBUG" : "VALIDATED"}; local results are not formal proof.\n`,
        );
    });
const trust = program.command("trust").description("Issuer roots persist across logout");
trust
    .command("refresh")
    .description("Refresh keys/revocations through authenticated HTTPS binding")
    .action(async () => {
        await new TrustStore(store().directory).refresh(await store().load(), controller.signal);
        process.stdout.write("Authenticated issuer trust refreshed.\n");
    });
trust
    .command("bind <public-metadata-file>")
    .requiredOption("--origin <origin>", "Administrator-confirmed control origin")
    .requiredOption(
        "--fingerprint <sha256>",
        "Out-of-band administrator verified active key fingerprint",
    )
    .action(async (file: string, options: { origin: string; fingerprint: string }) => {
        const raw = await readFile(file);
        if (raw.length > 65536) throw new Error("INVALID_ISSUER");
        await new TrustStore(store().directory).bind(
            JSON.parse(raw.toString()) as IssuerTrust,
            options.origin,
            options.fingerprint,
        );
        process.stdout.write("Out-of-band issuer fingerprint bound.\n");
    });
const secret = program
    .command("secret")
    .description("Exact local credential mappings; never print values");
secret
    .command("delete-profile")
    .description(
        "Permanently retire this local credential profile; keep trust/history and do not revoke the server device",
    )
    .option(
        "--confirm-all",
        "Confirm deleting every local credential purpose and exact vault key; use a new profile directory afterward",
    )
    .action(async (options: { confirmAll?: boolean }) => {
        if (options.confirmAll !== true)
            throw new Error("CREDENTIAL_PROFILE_DELETE_CONFIRMATION_REQUIRED");
        await store().deleteCredentials();
        process.stdout.write(
            "Local credential profile retired; trust/history retained. Server device revocation is separate. Use a new profile directory for future credentials.\n",
        );
    });
secret
    .command("recover-initialization")
    .description(
        "Explicitly recover an empty pending credential initialization; never replace an active missing key",
    )
    .action(async () => {
        await store().recoverCredentialInitialization();
        process.stdout.write(
            "Empty credential initialization recovered; prior key intents retained.\n",
        );
    });
secret
    .command("migrate")
    .description(
        "Explicitly migrate stopped local credentials using the selected mode; verify readback before retiring legacy files",
    )
    .action(async () => {
        await store().migrateCredentials();
        process.stdout.write(
            `Local credentials migrated and verified; credential mode: ${program.opts<{ credentialMode: string }>().credentialMode}.\n`,
        );
    });
for (const name of ["set", "remove"]) {
    const command = secret
        .command(name)
        .requiredOption("--issuer <id>", "Trusted issuer ID")
        .requiredOption("--workspace <id>", "Workspace UUID")
        .requiredOption("--ref <key>", "Exact secret reference")
        .requiredOption("--version <id>", "Exact version UUID");
    command.action(
        async (options: { issuer: string; workspace: string; ref: string; version: string }) => {
            const ref: SecretReference = {
                issuerId: options.issuer,
                workspaceId: options.workspace,
                secretRef: options.ref,
                versionId: options.version,
            };
            await new TrustStore(store().directory).issuer(ref.issuerId);
            const local = new SecretStore(store().directory, entryCredentials);
            if (name === "remove") await local.remove(ref);
            else {
                let input = "";
                for await (const chunk of process.stdin) {
                    input += String(chunk);
                    if (Buffer.byteLength(input) > 65536) throw new Error("SECRET_INPUT_LIMIT");
                }
                await local.set(ref, JSON.parse(input));
            }
            process.stdout.write("Local mapping updated.\n");
        },
    );
}
const localRoot = () => join(store().directory, "offline");
program
    .command("run")
    .description("Execute a signed installed bundle without the control service")
    .requiredOption("--offline <directory>", "Installed signed bundle directory")
    .option("--release-dir <directory>", "Installed approved engine release")
    .option("--browser-executable <path>", "Installed test browser")
    .option("--debug", "Explicit expired/unvalidated DEBUG execution")
    .option("--retry", "One safe whole-case retry at most")
    .option("--base-url <url>", "Explicit authorized public baseURL override")
    .option("--fixture-url <url>", "Explicit authorized public fixture URL override")
    .action(
        async (options: {
            offline: string;
            releaseDir: string;
            browserExecutable: string;
            debug?: boolean;
            retry?: boolean;
            baseUrl?: string;
            fixtureUrl?: string;
        }) => {
            const installed = await installedDistribution();
            if (
                installed &&
                ((options.releaseDir && options.releaseDir !== installed.engineDirectory) ||
                    (options.browserExecutable &&
                        options.browserExecutable !== installed.browserExecutable))
            )
                throw new Error("RUNTIME_CONFIGURATION_MISMATCH");
            const releaseDirectory = installed?.engineDirectory ?? options.releaseDir;
            const browserExecutable = installed?.browserExecutable ?? options.browserExecutable;
            if (!releaseDirectory || !browserExecutable)
                throw new Error("RUNTIME_CONFIGURATION_REQUIRED");
            process.title = "veriq_cli";
            const profile = store().directory;
            await updatePrivate<{ id: string }>(
                profile,
                "local-device.json",
                (old) => old ?? { id: randomUUID() },
            );
            const identity = await readPrivate<{ id: string }>(profile, "local-device.json");
            const overrides = {
                ...(options.baseUrl ? { baseURL: options.baseUrl } : {}),
                ...(options.fixtureUrl ? { fixtureBaseURL: options.fixtureUrl } : {}),
            };
            const result = await runOffline(
                { directory: options.offline },
                {
                    trust: new TrustStore(profile),
                    root: localRoot(),
                    secrets: new SecretStore(profile, entryCredentials),
                    releaseDirectory,
                    browserExecutable,
                    ...(installed ? { execution: installed.execution } : {}),
                    deviceId: identity.id,
                    debug: !!options.debug,
                    retry: !!options.retry,
                    overrides,
                    authorizeOverride: () => true,
                    signal: controller.signal,
                },
            );
            process.stdout.write(
                JSON.stringify({
                    localRunId: result.localRunId,
                    workspaceId: result.workspaceId,
                    outcome: result.outcome,
                    dirty: result.dirty,
                    revocationStatus: result.revocationStatus,
                }) + "\n",
            );
            process.exitCode =
                result.outcome === "PASSED" ? 0 : result.outcome === "CANCELLED" ? 130 : 1;
        },
    );
const results = program
    .command("results")
    .description("Durable local history, reports, cancellation and explicit upload");
results
    .command("history")
    .requiredOption("--workspace <id>", "Workspace UUID")
    .action(async (options: { workspace: string }) => {
        const local = await LocalStore.open(localRoot());
        try {
            process.stdout.write(JSON.stringify(local.history(options.workspace)) + "\n");
        } finally {
            local.close();
        }
    });
results
    .command("report <runId>")
    .requiredOption("--workspace <id>", "Workspace UUID")
    .action(async (runId: string, options: { workspace: string }) => {
        process.stdout.write(
            JSON.stringify(
                await new LocalReports(localRoot(), () => false).snapshot(options.workspace, runId),
            ) + "\n",
        );
    });
results
    .command("cancel <runId>")
    .requiredOption("--workspace <id>", "Workspace UUID")
    .action(async (runId: string, options: { workspace: string }) => {
        const local = await LocalStore.open(localRoot());
        try {
            local.cancel(options.workspace, runId);
        } finally {
            local.close();
        }
        process.stdout.write("Cancellation requested. Physical stop is recorded separately.\n");
    });
results
    .command("recover")
    .description("Reconcile an interrupted local host using native physical stop proof")
    .action(async () => {
        process.stdout.write(
            JSON.stringify((await recoverOffline(localRoot())) ?? { active: false }) + "\n",
        );
    });
results
    .command("upload <runId>")
    .description(
        "Upload using the separately enrolled current device; retain failed uploads for retry",
    )
    .action(async (runId: string) => {
        const profile = store(),
            saved = await profile.load();
        const current = await profile.renew(new RuntimeClient(saved.server));
        process.stdout.write(
            JSON.stringify(await uploadOffline(localRoot(), runId, current, controller.signal)) +
                "\n",
        );
    });
try {
    await program.parseAsync();
} catch (error) {
    const code =
        error instanceof RuntimeError
            ? error.code
            : controller.signal.aborted
              ? "CANCELLED"
              : error instanceof Error && /^[A-Z_]{1,60}$/.test(error.message)
                ? error.message
                : "OPERATION_FAILED";
    logger.error({ event: "command_failed", code }, "VeriQ command failed");
    process.stderr.write(
        `VeriQ: ${code}. Check doctor, connectivity and current authorization, then retry.\n`,
    );
    process.exitCode = controller.signal.aborted ? 130 : 1;
}
