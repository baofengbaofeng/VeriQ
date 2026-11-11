#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { TrustStore, type IssuerTrust } from "./offline/trust.ts";
import { verifyBundle } from "./offline/verify.ts";
import { downloadBundle } from "./offline/download.ts";
import { SecretStore, type SecretReference } from "./credentials/store.ts";
import { openTrace } from "./trace.ts";
/** Development CLI. Native launcher/process names and vault packaging are T20. */
import { Command } from "commander";
import pino from "pino";
import { join } from "node:path";
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
const program = new Command()
  .name("veriq_cli")
  .description("VeriQ Runtime enrollment and diagnostics (development)")
  .version("0.1.0");
program.option(
  "--config-dir <directory>",
  "Private development configuration directory",
);
const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());
program.command("trace").description("Privileged local evidence viewer").command("open <file>").description("Open a downloaded Trace locally using pinned Playwright").action((file: string) => openTrace(file, controller.signal));
const store = () =>
  new DeviceStore(program.opts<{ configDir?: string }>().configDir);
const common = (command: Command) =>
  command.option(
    "--browser-executable <path>",
    "Explicit test browser executable (otherwise Playwright installation)",
  );
common(
  program
    .command("doctor")
    .description(
      "Inspect Node, engine/SDK, browser launch and optional control network",
    )
    .option("--server <origin>", "Control service origin"),
).action(async (options: { server?: string; browserExecutable?: string }) => {
  const result = await doctor({
    server: options.server,
    executablePath: options.browserExecutable,
    signal: controller.signal,
  });
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
).action(
  async (options: {
    server: string;
    name: string;
    browserExecutable?: string;
  }) => {
    const deviceStore = store();
    try {
      await deviceStore.load();
      throw new Error("ALREADY_ENROLLED");
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ))
        throw error;
    }
    const client = new RuntimeClient(options.server);
    const diagnostics = await doctor({
      server: options.server,
      executablePath: options.browserExecutable,
      signal: controller.signal,
    });
    if (!diagnostics.ok || !diagnostics.capabilities)
      throw new Error("DOCTOR_FAILED");
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
        const receipt = await client.poll(
          enrollment.deviceCode,
          controller.signal,
        );
        await deviceStore.save({ server: client.server, ...receipt });
        process.stdout.write(
          `Registered ${receipt.runnerId} in Workspace ${receipt.workspaceId}. Worker is offline.\n`,
        );
        return;
      } catch (error) {
        if (!(
          error instanceof RuntimeError && error.code === "ENROLLMENT_PENDING"
        ))
          throw error;
      }
    }
    throw new Error("ENROLLMENT_EXPIRED");
  },
);
common(
  program
    .command("enroll-service")
    .description(
      "Register a cloud Runtime; read one-time deployment token from stdin",
    )
    .requiredOption("--server <origin>", "HTTPS control origin")
    .option("--name <name>", "Device name", hostname())
    .option(
      "--share-workspace",
      "Explicitly consent to Workspace sharing",
      false,
    ),
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
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ))
        throw error;
    }
    const client = new RuntimeClient(options.server);
    const diagnostics = await doctor({
      server: options.server,
      executablePath: options.browserExecutable,
      signal: controller.signal,
    });
    if (!diagnostics.ok || !diagnostics.capabilities)
      throw new Error("DOCTOR_FAILED");
    let secret = "";
    const timeout = setTimeout(
      () => process.stdin.destroy(new Error("INPUT_TIMEOUT")),
      30_000,
    );
    try {
      for await (const chunk of process.stdin) {
        secret += String(chunk);
        if (secret.length > 128) throw new Error("INVALID_TOKEN_INPUT");
      }
    } finally {
      clearTimeout(timeout);
    }
    secret = secret.trim();
    if (!/^[A-Za-z0-9_-]{43}$/.test(secret))
      throw new Error("INVALID_TOKEN_INPUT");
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
  .option(
    "--local-only",
    "Forget only the local device credential without remote revocation",
  )
  .action(async (options: { localOnly?: boolean }) => {
    const s = store();
    await s.ensureStopped();
    if (options.localOnly) {
      await s.remove();
      await new SecretStore(s.directory).clear();
      process.stdout.write(
        "Local device credential removed. Remote revocation was not attempted. The server credential may still be valid; revoke the device in the Web console or wait for expiry.\n",
      );
      return;
    }
    let config = await s.load();
    if (await s.hasPendingRotation()) config = await s.renew(new RuntimeClient(config.server));
    let alreadyRejected = false;
    try {
      await new RuntimeClient(config.server).logout(
        config.deviceToken,
        controller.signal,
      );
    } catch (error) {
      if (!(
        error instanceof RuntimeError &&
        error.status === 401 &&
        ["DEVICE_UNAUTHORIZED", "DEVICE_REVOKED"].includes(error.code)
      ))
        throw error;
      alreadyRejected = true;
    }
    await s.remove();
    await new SecretStore(s.directory).clear();
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
  .description(
    "Inspect registration and current authorization; does not start a worker",
  )
  .action(async () => {
    const config = await store().load();
    const info = await new RuntimeClient(config.server).inspectDevice(
      config.deviceToken,
      controller.signal,
    );
    process.stdout.write(
      `${info.name}: ${info.status}; current trust ${info.trustStatus}\n`,
    );
  });
const runtime = program.command("runtime").description("Run and control the online Linux Agent");
runtime.command("start").requiredOption("--release-dir <path>", "Operator-approved fixed engine release directory")
  .requiredOption("--browser-executable <path>", "Pinned Playwright browser executable")
  .option("--once", "Process at most one claim, then stop")
  .action(async (options: {releaseDir:string;browserExecutable:string;once?:boolean}) => {
    if (process.platform !== "linux") throw new Error("UNSUPPORTED_PROCESS_PLATFORM");
    process.title = "veriq_agent";
    const profile = store(), config = await profile.load(), client = new RuntimeClient(config.server);
    const session = new DeviceSession(profile, client);
    await session.open();
    const root = join(profile.directory, "agent");
    let close: (()=>Promise<void>) | undefined;
    try {
      close = await serveAgentControl(root, () => controller.abort());
      const transport = new AgentClient(session);
      const info = await transport.request<import("@veriq/contracts").PlatformComponents["schemas"]["RuntimeDTO"]>("/internal/v1/runtime");
      const supervisor = new ExecutionSupervisor({root, client:transport, releaseDirectory:options.releaseDir, browserExecutable:options.browserExecutable});
      await claimLoop({client:transport,supervisor,root,runnerId:config.runnerId,capabilities:info.capabilities,signal:controller.signal,...(options.once?{once:true}:{})});
    } finally {await close?.();await session.close();}
  });
runtime.command("status").action(async()=>{const result=await agentControl(join(store().directory,"agent"),"status");process.stdout.write(`Agent running: ${result.running}; PID ${result.pid}\n`);});
runtime.command("stop").action(async()=>{await agentControl(join(store().directory,"agent"),"stop");process.stdout.write("Agent stop requested; active Attempt cleanup and process confirmation precede shutdown.\n");});
const bundle = program.command("bundle").description("Download and verify signed offline data (no execution)");
bundle.command("download <bundle-id>").requiredOption("--output <path>", "New archive file").action(async(id:string,options:{output:string})=>{await downloadBundle(await store().load(),id,options.output,controller.signal);process.stdout.write("Bundle downloaded; verify before opening.\n");});
bundle.command("verify <file>").requiredOption("--destination <directory>","New read-only snapshot directory").option("--debug","Explicitly accept expired/unvalidated data; excludes formal gates").action(async(file:string,options:{destination:string;debug?:boolean})=>{const result=await verifyBundle(file,{trust:new TrustStore(store().directory),...options});process.stdout.write(`Verified ${result.manifest.bundleId}; revocation UNKNOWN; mode ${result.debug?"DEBUG":"VALIDATED"}; local results are not formal proof.\n`);});
const trust=program.command("trust").description("Issuer roots persist across logout");
trust.command("refresh").description("Refresh keys/revocations through authenticated HTTPS binding").action(async()=>{await new TrustStore(store().directory).refresh(await store().load(),controller.signal);process.stdout.write("Authenticated issuer trust refreshed.\n");});
trust.command("bind <public-metadata-file>").requiredOption("--origin <origin>","Administrator-confirmed control origin").requiredOption("--fingerprint <sha256>","Out-of-band administrator verified active key fingerprint").action(async(file:string,options:{origin:string;fingerprint:string})=>{const raw=await readFile(file);if(raw.length>65536)throw new Error("INVALID_ISSUER");await new TrustStore(store().directory).bind(JSON.parse(raw.toString()) as IssuerTrust,options.origin,options.fingerprint);process.stdout.write("Out-of-band issuer fingerprint bound.\n");});
const secret=program.command("secret").description("Exact local credential mappings; never print values");
for(const name of ["set","remove"]){
 const command=secret.command(name).requiredOption("--issuer <id>","Trusted issuer ID").requiredOption("--workspace <id>","Workspace UUID").requiredOption("--ref <key>","Exact secret reference").requiredOption("--version <id>","Exact version UUID");
 command.action(async(options:{issuer:string;workspace:string;ref:string;version:string})=>{
  const ref:SecretReference={issuerId:options.issuer,workspaceId:options.workspace,secretRef:options.ref,versionId:options.version};await new TrustStore(store().directory).issuer(ref.issuerId);const local=new SecretStore(store().directory);
  if(name==="remove")await local.remove(ref);else{
   let input="";for await(const chunk of process.stdin){input+=String(chunk);if(Buffer.byteLength(input)>65536)throw new Error("SECRET_INPUT_LIMIT");}await local.set(ref,JSON.parse(input));
  }process.stdout.write("Local mapping updated.\n");
 });
}
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
