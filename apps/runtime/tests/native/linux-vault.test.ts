/** 真实 Linux 保险库验收只启动本次自有总线与非空密码的合成 keyring，所有请求经过正式库存辅助程序；每个守护进程保留创建身份并在失败路径清理，结果不冒充正常用户登录会话或正式无人值守解锁策略。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, readlink, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { LinuxVaultBackend, type VaultHelperObservation } from "../../src/credentials/linux.ts";
import { vaultDistribution } from "../fixtures/vault-distribution.ts";

type Identity = { pid: number; start: string; executable: string; uid: number };
type Owned = {
    child: ChildProcessWithoutNullStreams;
    identity: Identity | null;
    acquisitionFailed: boolean;
    spawnFailed: boolean;
    exit: Promise<void>;
    closed: Promise<void>;
    exited: boolean;
    output: string;
    outputBytes: number;
    errorBytes: number;
    code: number | null;
    signal: NodeJS.Signals | null;
};
type VerifiedOwned = Owned & { identity: Identity };

/** 进程身份同时记录内核启动时刻与实际执行文件，后续清理必须重核这两个事实才发信号；单独 PID 存在或进程名称相同不能证明仍是本测试创建的守护进程，更不能授权终止登录会话中的其他服务。 */
async function identity(pid: number): Promise<Identity> {
    const value = await readFile(`/proc/${pid}/stat`, "utf8");
    const status = await readFile(`/proc/${pid}/status`, "utf8");
    const uid = status.match(/^Uid:\s+(\d+)/m)?.[1];
    if (uid === undefined) throw new Error("VAULT_FIXTURE_UID_MISSING");
    return {
        pid,
        start: value.slice(value.lastIndexOf(")") + 2).split(" ")[19]!,
        executable: await readlink(`/proc/${pid}/exe`),
        uid: Number(uid),
    };
}
async function until(check: () => Promise<boolean>, timeout = 5000) {
    const end = performance.now() + timeout;
    while (!(await check())) {
        if (performance.now() >= end) throw new Error("VAULT_FIXTURE_WAIT_TIMEOUT");
        await delay(25);
    }
}

/** 正式消费者组合在同一自有 Secret Service 会话中使用完整发行能力构造后端，迁移和重启读回经过真实 helper；合成值仅用于确认磁盘没有明文，日志只记录是否成功及生命周期，不打印业务值或系统密钥。 */
test("real private Secret Service lifecycle, prompt refusal and owned helper termination", async (t) => {
    assert.equal(process.platform, "linux");
    const evidence = process.env.VERIQ_VAULT_EVIDENCE;
    assert(evidence, "VAULT_EVIDENCE_REQUIRED");
    await mkdir(evidence, { recursive: true });
    const root = await mkdtemp(join(tmpdir(), "veriq-vault-session-"));
    const fixture = await vaultDistribution(await readFile(resolve("build/vault/veriq_agent")));
    const driver = resolve("build/vault-test/veriq_agent");
    const records: Owned[] = [];
    const observations: VaultHelperObservation[] = [];
    const facts: Record<string, unknown> = {
        acceptance:
            "Owned private Secret Service; not desktop login or unattended production policy",
        root,
        observations,
    };
    const password = randomBytes(32).toString("base64url");
    const key = randomBytes(32);
    const scope = { profileId: randomUUID(), keyVersion: randomUUID() };
    const otherProfile = { ...scope, profileId: randomUUID() },
        otherVersion = { ...scope, keyVersion: randomUUID() };
    const env: NodeJS.ProcessEnv = {
        PATH: "/usr/bin:/bin",
        LANG: "C.UTF-8",
        ...(process.env.HOME === undefined ? {} : { HOME: process.env.HOME }),
        XDG_DATA_HOME: join(root, "data"),
        XDG_CONFIG_HOME: join(root, "config"),
        XDG_RUNTIME_DIR: join(root, "runtime"),
    };
    for (const path of [
        env.XDG_DATA_HOME!,
        env.XDG_CONFIG_HOME!,
        env.XDG_RUNTIME_DIR!,
        join(root, "control"),
    ])
        await mkdir(path, { mode: 0o700 });
    const previous = new Map(
        Object.keys(env)
            .filter((name) => name !== "HOME")
            .map((name) => [name, process.env[name]]),
    );
    previous.set("DBUS_SESSION_BUS_ADDRESS", process.env.DBUS_SESSION_BUS_ADDRESS);
    const ownership = async () =>
        writeFile(
            join(evidence, "fixture-ownership.json"),
            JSON.stringify(
                {
                    roots: [root, fixture.root],
                    processes: records
                        .map((value) => value.identity)
                        .filter((value) => value !== null),
                    identityIncomplete: records.some((value) => !value.identity && !value.exited),
                    incompletePids: records
                        .filter((value) => !value.identity && !value.exited)
                        .map((value) => value.child.pid),
                },
                null,
                2,
            ) + "\n",
            { mode: 0o600 },
        );

    /** 夹具只记录实际创建进程的内核身份与有界非秘密输出，总线地址可用于本次私有会话但密码永不进入参数或证据；普通停止先请求退出再有限升级，只有真实 exit 事件才能记为清理完成。 */
    const start = async (file: string, args: string[]): Promise<VerifiedOwned> => {
        const child = spawn(file, args, { env, stdio: ["pipe", "pipe", "pipe"] });
        let exitResolve!: () => void;
        let closeResolve!: () => void;
        const owned: Owned = {
            child,
            identity: null,
            acquisitionFailed: false,
            spawnFailed: false,
            exit: new Promise<void>((resolve) => {
                exitResolve = resolve;
            }),
            closed: new Promise<void>((resolve) => {
                closeResolve = resolve;
            }),
            exited: false,
            output: "",
            outputBytes: 0,
            errorBytes: 0,
            code: null,
            signal: null,
        };
        child.on("error", () => {
            if (child.pid === undefined) {
                owned.spawnFailed = true;
                owned.exited = true;
                exitResolve();
            }
        });
        child.on("close", () => closeResolve());
        child.on("exit", (code, signal) => {
            owned.exited = true;
            owned.code = code;
            owned.signal = signal;
            exitResolve();
        });
        child.stdin.on("error", () => {});
        child.stdout.on("data", (bytes: Buffer) => {
            owned.outputBytes += bytes.length;
            if (owned.outputBytes <= 4096) owned.output += bytes.toString("utf8");
        });
        child.stderr.on("data", (bytes: Buffer) => {
            owned.errorBytes += bytes.length;
        });
        records.push(owned);
        try {
            await ownership();
            assert(child.pid, "VAULT_FIXTURE_SPAWN_FAILED");
            owned.identity = await identity(child.pid);
            await ownership();
            return owned as VerifiedOwned;
        } catch (error) {
            /** 子进程一经创建就先保留真实 ChildProcess 所有权，身份捕获或登记失败时只能关闭这一个新取得的句柄并等待实际退出；未知身份不得伪造到兜底登记中，也不能在异常路径留下无法追踪的活进程。 */
            owned.acquisitionFailed = true;
            if (!owned.exited) {
                child.kill("SIGCONT");
                child.kill("SIGTERM");
                await Promise.race([owned.exit, delay(1500)]);
                if (!owned.exited) {
                    child.kill("SIGKILL");
                    await Promise.race([owned.exit, delay(1000)]);
                }
            }
            await ownership();
            if (!owned.exited)
                throw new AggregateError([error], "VAULT_FIXTURE_ACQUISITION_EXIT_UNCONFIRMED");
            throw error;
        }
    };
    const stop = async (owned: Owned) => {
        if (owned.exited) return;
        assert(owned.identity, "VAULT_FIXTURE_IDENTITY_INCOMPLETE");
        assert.deepEqual(await identity(owned.identity.pid), owned.identity);
        owned.child.kill("SIGCONT");
        owned.child.kill("SIGTERM");
        await Promise.race([owned.exit, delay(1500)]);
        if (!owned.exited) {
            owned.child.kill("SIGKILL");
            await Promise.race([owned.exit, delay(1000)]);
        }
        assert(owned.exited, "VAULT_FIXTURE_EXIT_UNCONFIRMED");
    };
    const direct = async (path: string, frame: string, expectedCode = 0) => {
        const owned = await start(path, []);
        owned.child.stdin.write(frame);
        try {
            await Promise.race([owned.closed, delay(5000)]);
            assert(owned.exited, "VAULT_DRIVER_TIMEOUT");
            assert.equal(owned.code, expectedCode);
            assert.equal(owned.signal, null);
            assert.equal(owned.errorBytes, 0);
            return owned.output;
        } finally {
            await stop(owned);
        }
    };
    let daemon: VerifiedOwned | undefined;
    let bus: VerifiedOwned | undefined;
    let cleanupError: unknown;
    const backend = new LinuxVaultBackend(fixture.distribution, {
        observe: (value) => observations.push(value),
    });
    const signal = () => new AbortController().signal;
    const ready = async () =>
        until(async () => (await backend.probe(signal())).status === "ready", 10000);
    const startDaemon = async (unlock: boolean) => {
        const owned = await start("/usr/bin/gnome-keyring-daemon", [
            "--foreground",
            "--components=secrets",
            `--control-directory=${join(root, "control")}`,
            ...(unlock ? ["--unlock"] : []),
        ]);
        if (unlock) owned.child.stdin.end(password);
        else owned.child.stdin.end();
        return owned;
    };
    try {
        await ownership();
        const configuration = join(root, "bus.conf");
        await writeFile(
            configuration,
            `<busconfig><type>session</type><listen>unix:tmpdir=${env.XDG_RUNTIME_DIR}</listen><auth>EXTERNAL</auth><policy context="default"><allow send_destination="*"/><allow own="*"/><allow eavesdrop="true"/></policy></busconfig>`,
            { mode: 0o600 },
        );
        bus = await start("/usr/bin/dbus-daemon", [
            "--nofork",
            "--print-address=1",
            `--config-file=${configuration}`,
        ]);
        await until(async () => bus!.output.includes("\n"));
        env.DBUS_SESSION_BUS_ADDRESS = bus.output.trim();
        assert.match(env.DBUS_SESSION_BUS_ADDRESS, /^unix:/);
        for (const [name, value] of Object.entries(env))
            if (name !== "HOME") process.env[name] = value;
        assert.equal(process.env.HOME, env.HOME);
        facts.environment = {
            realHomePreserved: true,
            isolatedData: env.XDG_DATA_HOME,
            isolatedConfig: env.XDG_CONFIG_HOME,
            isolatedRuntime: env.XDG_RUNTIME_DIR,
        };
        await t.test(
            "production binary refuses test commands and malformed empty frames",
            async () => {
                for (const frame of [
                    "V1 prompt\n",
                    "V1 lock\n",
                    `V1 shape ${scope.profileId} ${scope.keyVersion}\n`,
                    "\n",
                ])
                    assert.equal(
                        await direct(join(fixture.root, "native/vault/veriq_agent"), frame, 2),
                        "",
                    );
            },
        );
        await t.test(
            "service absence is unavailable on own bus without activation directories",
            async () => {
                assert.equal((await backend.probe(signal())).status, "unavailable");
            },
        );
        daemon = await startDaemon(true);
        await ready();
        await t.test(
            "real key create/read, same-value recovery, conflict refusal and exact scope isolation",
            async () => {
                assert.equal((await backend.get(scope, signal())).status, "missing");
                assert.equal((await backend.set(scope, key, signal())).status, "ok");
                const shape = await direct(
                    driver,
                    `V1 shape ${scope.profileId} ${scope.keyVersion}\n`,
                );
                facts.keyShape = { response: shape.trim(), separateTestBinary: true };
                process.stdout.write("VAULT_KEY_SHAPE " + shape);
                assert.match(shape, /^V1 key-shape 32 (octet-stream|text-plain)\n$/);
                assert.equal((await backend.set(scope, Buffer.from(key), signal())).status, "ok");
                assert.equal(
                    (await backend.set(scope, randomBytes(32), signal())).status,
                    "failed",
                );
                const result = await backend.get(scope, signal());
                assert.equal(result.status, "ok");
                if (result.status === "ok") assert(result.key.equals(key), "VAULT_KEY_MISMATCH");
                assert.equal((await backend.get(otherProfile, signal())).status, "missing");
                assert.equal((await backend.get(otherVersion, signal())).status, "missing");
                assert.equal((await backend.set(otherProfile, key, signal())).status, "ok");
                assert.equal((await backend.set(otherVersion, key, signal())).status, "ok");
                const upper = {
                    profileId: "ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF",
                    keyVersion: "FEDCBAFE-DCBA-4FED-8CBA-FEDCBAFEDCBA",
                };
                assert.equal((await backend.set(upper, key, signal())).status, "ok");
                const upperResult = await backend.get(upper, signal());
                assert.equal(upperResult.status, "ok");
                if (upperResult.status === "ok")
                    assert(upperResult.key.equals(key), "VAULT_KEY_MISMATCH");
                assert.equal(
                    (
                        await backend.get(
                            {
                                profileId: upper.profileId.toLowerCase(),
                                keyVersion: upper.keyVersion.toLowerCase(),
                            },
                            signal(),
                        )
                    ).status,
                    "missing",
                );
                assert.equal((await backend.delete(upper, signal())).status, "ok");
            },
        );
        const productionProfile = join(root, "production-profile");
        const productionReference = {
            issuerId: "owned",
            workspaceId: randomUUID(),
            secretRef: "login",
            versionId: randomUUID(),
        };
        const productionDevice = {
            server: "https://control.example",
            runnerId: randomUUID(),
            workspaceId: productionReference.workspaceId,
            deviceToken: "synthetic-production-device-token",
            expiresAt: "2027-12-01T00:00:00Z",
        };
        const { installedCredentials } = await import("../../src/credentials/host.ts");
        const { CredentialProfile } = await import("../../src/credentials/profile.ts");
        const { SecretStore } = await import("../../src/credentials/store.ts");
        const { DeviceStore } = await import("../../src/enrollment.ts");
        const productionOptions = installedCredentials(fixture.distribution);
        await t.test(
            "production consumers migrate and persist through the verified formal OS helper",
            async () => {
                await new SecretStore(productionProfile).set(productionReference, {
                    password: "synthetic-production-password",
                });
                await new DeviceStore(productionProfile).save(productionDevice);
                await assert.rejects(
                    new DeviceStore(productionProfile, productionOptions).load(),
                    /VAULT_MIGRATION_REQUIRED/,
                );
                await new CredentialProfile(productionProfile, productionOptions).migrate();
                assert.deepEqual(
                    await new DeviceStore(productionProfile, productionOptions).load(),
                    productionDevice,
                );
                assert.deepEqual(
                    await new SecretStore(productionProfile, productionOptions).resolve(
                        productionReference,
                    ),
                    { password: "synthetic-production-password" },
                );
                const members = await readdir(join(productionProfile, "vault"));
                for (const name of members) {
                    const wire = await readFile(join(productionProfile, "vault", name), "utf8");
                    assert.equal(wire.includes("synthetic-production-password"), false);
                    assert.equal(wire.includes(productionDevice.deviceToken), false);
                }
                facts.productionConsumers = {
                    formalHelper: true,
                    migrationReadback: true,
                    ciphertextOnly: true,
                };
            },
        );
        await t.test("real locked collection and prompt-producing unlock are refused", async () => {
            assert.equal(await direct(driver, "V1 lock\n"), "V1 ok\n");
            assert.equal((await backend.probe(signal())).status, "locked");
            assert.equal((await backend.get(scope, signal())).status, "locked");
            assert.equal(await direct(driver, "V1 prompt\n"), "V1 prompt-denied\n");
            assert.equal((await backend.probe(signal())).status, "locked");
            facts.prompt = {
                realUnlockRequested: true,
                privateVfuncRefused: true,
                collectionRemainedLocked: true,
                separateTestBinary: true,
            };
        });
        await t.test(
            "nonempty password unlock and daemon restart preserve actual key material",
            async () => {
                await stop(daemon!);
                daemon = await startDaemon(true);
                await ready();
                const result = await backend.get(scope, signal());
                assert.equal(result.status, "ok");
                if (result.status === "ok") assert(result.key.equals(key), "VAULT_KEY_MISMATCH");
                facts.restart = {
                    oldDaemonExited: true,
                    newDaemon: daemon.identity,
                    nonemptyPassword: true,
                    sameKey: true,
                };
            },
        );
        await t.test(
            "production profile reopens after the real password-protected daemon restart",
            async () => {
                const reopened = installedCredentials(fixture.distribution);
                assert.deepEqual(
                    await new SecretStore(productionProfile, reopened).resolve(productionReference),
                    { password: "synthetic-production-password" },
                );
                assert.deepEqual(
                    await new DeviceStore(productionProfile, reopened).load(),
                    productionDevice,
                );
                await new DeviceStore(productionProfile, reopened).remove();
                assert.deepEqual(
                    await new SecretStore(productionProfile, reopened).resolve(productionReference),
                    { password: "synthetic-production-password" },
                );
                await new SecretStore(productionProfile, reopened).clear();
                facts.productionRestart = {
                    sameValues: true,
                    purposeIsolation: true,
                    cleared: true,
                };
            },
        );
        await t.test(
            "duplicate exact matches are refused without selecting or deleting either item",
            async () => {
                const duplicate = { profileId: randomUUID(), keyVersion: randomUUID() };
                const frame = `V1 duplicate ${duplicate.profileId} ${duplicate.keyVersion} ${randomBytes(32).toString("base64url")}\n`;
                assert.equal(await direct(driver, frame), "V1 ok\n");
                assert.equal(await direct(driver, frame), "V1 ok\n");
                assert.equal((await backend.get(duplicate, signal())).status, "failed");
                assert.equal((await backend.delete(duplicate, signal())).status, "failed");
                assert.equal((await backend.get(scope, signal())).status, "ok");
            },
        );
        await t.test(
            "paused own daemon makes deadlines/cancellation bounded with real helper exits",
            async () => {
                assert.deepEqual(await identity(daemon!.identity.pid), daemon!.identity);
                daemon!.child.kill("SIGSTOP");
                try {
                    const timed = new LinuxVaultBackend(fixture.distribution, {
                        timeoutMs: 800,
                        observe: (value) => observations.push(value),
                    });
                    const pending = timed.get(scope, signal());
                    const known = new Set(records.map((value) => value.child.pid));
                    let helperPid: number | undefined;
                    await until(async () => {
                        const children = (
                            await readFile(
                                `/proc/${process.pid}/task/${process.pid}/children`,
                                "utf8",
                            )
                        )
                            .trim()
                            .split(/\s+/)
                            .map(Number);
                        for (const pid of children)
                            if (pid && !known.has(pid)) {
                                try {
                                    if (
                                        (await readlink(`/proc/${pid}/exe`)) ===
                                        join(fixture.root, "native/vault/veriq_agent")
                                    ) {
                                        helperPid = pid;
                                        return true;
                                    }
                                } catch (error) {
                                    if (
                                        !["ENOENT", "ESRCH"].includes(
                                            (error as NodeJS.ErrnoException).code ?? "",
                                        )
                                    )
                                        throw error;
                                }
                            }
                        return false;
                    }, 500);
                    facts.loadedHelper = {
                        identity: await identity(helperPid!),
                        comm: (await readFile(`/proc/${helperPid}/comm`, "utf8")).trim(),
                        maps: await readFile(`/proc/${helperPid}/maps`, "utf8"),
                    };
                    assert.equal((await pending).status, "failed");
                    const mutationScope = { ...scope, keyVersion: randomUUID() };
                    assert.equal(
                        (await timed.set(mutationScope, randomBytes(32), signal())).status,
                        "mutation-unconfirmed",
                    );
                    const abort = new AbortController();
                    const cancelled = backend.get(scope, abort.signal);
                    setTimeout(() => abort.abort(), 100);
                    assert.equal((await cancelled).status, "failed");
                    assert.deepEqual(await identity(daemon!.identity.pid), daemon!.identity);
                    daemon!.child.kill("SIGCONT");
                    await ready();
                    assert.equal((await backend.get(mutationScope, signal())).status, "missing");
                    facts.uncertainReadback = "missing-after-resume; no automatic mutation retry";
                } finally {
                    if (!daemon!.exited) daemon!.child.kill("SIGCONT");
                }
            },
        );
        await t.test("parent death terminates a real blocked native helper", async () => {
            daemon!.child.kill("SIGSTOP");
            const program = join(root, "parent.mjs");
            await writeFile(
                program,
                `import {spawn} from 'node:child_process';const child=spawn(${JSON.stringify(join(fixture.root, "native/vault/veriq_agent"))},[],{stdio:['pipe','ignore','ignore']});child.stdin.write('V1 probe\\n');process.stdout.write(String(child.pid)+'\\n');setInterval(()=>{},1000);`,
                { mode: 0o600 },
            );
            let parent: VerifiedOwned | undefined;
            try {
                parent = await start(process.execPath, [program]);
                await until(async () => parent!.output.includes("\n"));
                const pid = Number(parent.output.trim());
                const before = await identity(pid);
                assert.equal(before.executable, join(fixture.root, "native/vault/veriq_agent"));
                parent.child.kill("SIGKILL");
                await parent.exit;
                await until(async () => {
                    try {
                        await readFile(`/proc/${pid}/stat`);
                        return false;
                    } catch (error) {
                        if (
                            ["ENOENT", "ESRCH"].includes(
                                (error as NodeJS.ErrnoException).code ?? "",
                            )
                        )
                            return true;
                        throw error;
                    }
                }, 3000);
                facts.parentDeath = {
                    parent: parent.identity,
                    parentSignal: parent.signal,
                    helper: before,
                    helperGone: true,
                };
                assert.equal((facts.loadedHelper as { comm: string }).comm, "veriq_agent");
                assert.match((facts.loadedHelper as { maps: string }).maps, /libsecret-1\.so\.0/);
            } finally {
                if (parent) await stop(parent);
                if (!daemon!.exited) daemon!.child.kill("SIGCONT");
            }
            await ready();
        });
        await t.test(
            "delete is exact and service disappearance never becomes missing",
            async () => {
                assert.equal((await backend.delete(scope, signal())).status, "ok");
                assert.equal((await backend.get(scope, signal())).status, "missing");
                assert.equal((await backend.delete(scope, signal())).status, "missing");
                for (const other of [otherProfile, otherVersion]) {
                    assert.equal((await backend.get(other, signal())).status, "ok");
                    assert.equal((await backend.delete(other, signal())).status, "ok");
                }
                await stop(daemon!);
                assert.equal((await backend.get(scope, signal())).status, "unavailable");
            },
        );
        assert(observations.every((value) => value.exitConfirmed));
    } finally {
        for (const owned of [...records].reverse()) {
            try {
                await stop(owned);
            } catch (error) {
                cleanupError ??= error;
            }
        }
        for (const [name, value] of previous) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
        facts.processes = records.map(
            ({
                child,
                identity,
                acquisitionFailed,
                spawnFailed,
                exited,
                code,
                signal,
                outputBytes,
                errorBytes,
            }) => ({
                pid: child.pid,
                identity,
                acquisitionFailed,
                spawnFailed,
                exited,
                code,
                signal,
                outputBytes,
                errorBytes,
            }),
        );
        facts.cleanup = {
            allOwnedExited: records.every((value) => value.exited),
            error: cleanupError instanceof Error ? cleanupError.message : null,
        };
        await writeFile(
            join(evidence, "real-vault-observations.json"),
            JSON.stringify(facts, null, 2) + "\n",
            { mode: 0o600 },
        );
        if (!cleanupError) {
            await fixture.cleanup();
            await rm(root, { recursive: true, force: true });
        }
        if (cleanupError) throw cleanupError;
    }
});
