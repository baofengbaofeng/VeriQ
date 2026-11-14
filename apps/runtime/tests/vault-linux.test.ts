/** 本地 Linux 后端测试运行实际自有子进程来观察协议、环境投影和取消后的真实退出，所有密钥都为合成内存值；脚本夹具只验证宿主边界，不替代目标系统 libsecret 或真实锁定保险库的证据。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { LinuxVaultBackend, type VaultHelperObservation } from "../src/credentials/linux.ts";
import { loadRuntimeDistribution, verifiedVaultHelper } from "../src/distribution.ts";
import { vaultDistribution } from "./fixtures/vault-distribution.ts";

const scope = {
    profileId: "11111111-1111-4111-8111-111111111111",
    keyVersion: "22222222-2222-4222-8222-222222222222",
};
const signal = () => new AbortController().signal;
const linux = { skip: process.platform !== "linux" };
const script = (body: string) => Buffer.from(`#!${process.execPath}\n${body}\n`);
const receive = (body: string) =>
    script(
        `let frame='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{frame+=chunk;if(frame.includes('\\n')){${body}}});`,
    );

test(
    "vault capability requires the actual inventoried object and fixed member",
    linux,
    async () => {
        const missing = await vaultDistribution();
        const fixture = await vaultDistribution(
            receive("process.stdout.end('V1 ready\\n',()=>process.exit(0));"),
        );
        try {
            assert.throws(
                () => new LinuxVaultBackend(missing.distribution),
                /RUNTIME_VAULT_CAPABILITY_UNVERIFIED/,
            );
            assert.throws(
                () => verifiedVaultHelper({ ...fixture.distribution }),
                /RUNTIME_VAULT_CAPABILITY_UNVERIFIED/,
            );
            assert.equal(
                verifiedVaultHelper(fixture.distribution),
                join(fixture.root, "native/vault/veriq_agent"),
            );
            await writeFile(join(fixture.root, "native/vault/veriq_agent"), "tampered");
            await assert.rejects(loadRuntimeDistribution(fixture.root), /RUNTIME_FILE_MISMATCH/);
        } finally {
            await missing.cleanup();
            await fixture.cleanup();
        }
    },
);

test(
    "request stdin stays open until helper exits and response requires actual normal exit",
    linux,
    async () => {
        const observations: VaultHelperObservation[] = [];
        const fixture = await vaultDistribution(
            receive(
                "process.stdin.on('end',()=>process.exit(9));setTimeout(()=>process.stdout.write('V1 ready\\n',()=>process.exit(0)),60);",
            ),
        );
        try {
            const backend = new LinuxVaultBackend(fixture.distribution, {
                observe: (value) => observations.push(value),
            });
            assert.deepEqual(await backend.probe(signal()), { status: "ready" });
            assert.equal(observations.length, 1);
            assert.equal(observations[0]!.code, 0);
            assert.equal(observations[0]!.signal, null);
            assert.equal(observations[0]!.exitConfirmed, true);
            assert.throws(() => process.kill(observations[0]!.pid!, 0), { code: "ESRCH" });
        } finally {
            await fixture.cleanup();
        }
    },
);

test(
    "canonical fixed key response is independent and invalid scopes never spawn",
    linux,
    async () => {
        const key = randomBytes(32);
        const upper = {
            profileId: "ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF",
            keyVersion: "FEDCBAFE-DCBA-4FED-8CBA-FEDCBAFEDCBA",
        };
        const fixture = await vaultDistribution(
            receive(
                `if(!${JSON.stringify([`V1 get ${scope.profileId} ${scope.keyVersion}\n`, `V1 get ${upper.profileId} ${upper.keyVersion}\n`])}.includes(frame))process.exit(8);process.stdout.write('V1 ok ${key.toString("base64url")}\\n',()=>process.exit(0));`,
            ),
        );
        const observations: VaultHelperObservation[] = [];
        try {
            const backend = new LinuxVaultBackend(fixture.distribution, {
                observe: (value) => observations.push(value),
            });
            const result = await backend.get(scope, signal());
            assert.equal(result.status, "ok");
            if (result.status === "ok") {
                assert(result.key.equals(key));
                result.key.fill(0);
                assert(!result.key.equals(key));
            }
            assert.equal((await backend.get(upper, signal())).status, "ok");
            assert.deepEqual(await backend.get({ ...scope, keyVersion: "latest" }, signal()), {
                status: "failed",
            });
            assert.deepEqual(await backend.set(scope, Buffer.alloc(31), signal()), {
                status: "failed",
            });
            const aborted = new AbortController();
            aborted.abort();
            assert.deepEqual(await backend.delete(scope, aborted.signal), { status: "failed" });
            assert.equal(observations.length, 2);
            for (const timeoutMs of [0, 49, 5001, NaN])
                assert.throws(
                    () => new LinuxVaultBackend(fixture.distribution, { timeoutMs }),
                    /VAULT_DEADLINE_INVALID/,
                );
        } finally {
            await fixture.cleanup();
        }
    },
);

test("set uses bounded stdin without secrets in argv and preserves caller key", linux, async () => {
    const fixture = await vaultDistribution(
        receive(
            "const parts=frame.trim().split(' ');if(process.argv.length!==2||parts.length!==5||parts[1]!=='set'||Buffer.from(parts[4],'base64url').length!==32)process.exit(7);process.stdout.write('V1 ok\\n',()=>process.exit(0));",
        ),
    );
    const key = randomBytes(32),
        original = Buffer.from(key);
    try {
        assert.deepEqual(
            await new LinuxVaultBackend(fixture.distribution).set(scope, key, signal()),
            { status: "ok" },
        );
        assert(key.equals(original));
    } finally {
        await fixture.cleanup();
    }
});

test(
    "only session environment is projected into helper; injection variables are absent",
    linux,
    async () => {
        const fixture = await vaultDistribution(
            receive(
                "if(['LD_PRELOAD','LD_LIBRARY_PATH','NODE_OPTIONS','PYTHONPATH','GIO_EXTRA_MODULES'].some(k=>Object.hasOwn(process.env,k))||process.env.PATH!=='/usr/bin:/bin')process.exit(7);process.stdout.write('V1 ready\\n',()=>process.exit(0));",
            ),
        );
        const old = process.env.GIO_EXTRA_MODULES;
        process.env.GIO_EXTRA_MODULES = "/synthetic/untrusted";
        try {
            assert.deepEqual(await new LinuxVaultBackend(fixture.distribution).probe(signal()), {
                status: "ready",
            });
        } finally {
            if (old === undefined) delete process.env.GIO_EXTRA_MODULES;
            else process.env.GIO_EXTRA_MODULES = old;
            await fixture.cleanup();
        }
    },
);

test(
    "typed service failures remain distinct and malformed or excess output fails closed",
    linux,
    async () => {
        for (const status of ["missing", "locked", "unavailable", "failed"] as const) {
            const fixture = await vaultDistribution(
                receive(`process.stdout.write('V1 ${status}\\n',()=>process.exit(0));`),
            );
            try {
                assert.deepEqual(
                    await new LinuxVaultBackend(fixture.distribution).get(scope, signal()),
                    { status },
                );
            } finally {
                await fixture.cleanup();
            }
        }
        for (const body of [
            "process.stdout.end('V1 ok bad=\\n',()=>process.exit(0));",
            "process.stdout.end('V1 ready\\nV1 ready\\n',()=>process.exit(0));",
            "process.stdout.write('x'.repeat(513));",
            "process.stderr.write('x'.repeat(4097));",
            "process.stdout.end('V1 ready\\n',()=>process.exit(3));",
        ]) {
            const fixture = await vaultDistribution(receive(body));
            try {
                assert.deepEqual(
                    await new LinuxVaultBackend(fixture.distribution, { timeoutMs: 500 }).probe(
                        signal(),
                    ),
                    { status: "failed" },
                );
            } finally {
                await fixture.cleanup();
            }
        }
    },
);

test(
    "deadline and cancellation stop only the owned child and mark writes unconfirmed",
    linux,
    async () => {
        const fixture = await vaultDistribution(receive("setInterval(()=>{},1000);"));
        const observations: VaultHelperObservation[] = [];
        try {
            const backend = new LinuxVaultBackend(fixture.distribution, {
                timeoutMs: 100,
                observe: (value) => observations.push(value),
            });
            assert.deepEqual(await backend.get(scope, signal()), { status: "failed" });
            assert.deepEqual(await backend.set(scope, randomBytes(32), signal()), {
                status: "mutation-unconfirmed",
            });
            const abort = new AbortController();
            const pending = new LinuxVaultBackend(fixture.distribution, {
                observe: (value) => observations.push(value),
            }).delete(scope, abort.signal);
            setTimeout(() => abort.abort(), 80);
            assert.deepEqual(await pending, { status: "mutation-unconfirmed" });
            assert.equal(observations.length, 3);
            for (const observation of observations) {
                assert(observation.exitConfirmed);
                assert.throws(() => process.kill(observation.pid!, 0), { code: "ESRCH" });
            }
        } finally {
            await fixture.cleanup();
        }
    },
);

test(
    "concurrent instances cannot spawn a replacement before the owned helper exits",
    linux,
    async () => {
        const fixture = await vaultDistribution(receive("setInterval(()=>{},1000);"));
        const observations: VaultHelperObservation[] = [];
        try {
            const first = new LinuxVaultBackend(fixture.distribution, {
                timeoutMs: 100,
                observe: (value) => observations.push(value),
            });
            const pending = first.get(scope, signal());
            assert.deepEqual(
                await new LinuxVaultBackend(fixture.distribution).delete(scope, signal()),
                { status: "failed" },
            );
            assert.deepEqual(await pending, { status: "failed" });
            assert.equal(observations.length, 1);
            assert(observations[0]!.exitConfirmed);
            await first.get(scope, signal());
            assert.equal(observations.length, 2);
        } finally {
            await fixture.cleanup();
        }
    },
);

test(
    "independent cleanup verifies creation identity, reaps owned child and preserves unrelated process",
    linux,
    async () => {
        const root = await mkdtemp(join(tmpdir(), "veriq-vault-session-"));
        const evidence = await mkdtemp(join(tmpdir(), "veriq-vault-cleanup-evidence-"));
        const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
            stdio: "ignore",
        });
        const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
            (resolve) => child.once("exit", (code, signal) => resolve({ code, signal })),
        );
        try {
            assert(child.pid);
            const stat = await readFile(`/proc/${child.pid}/stat`, "utf8");
            await writeFile(
                join(evidence, "fixture-ownership.json"),
                JSON.stringify({
                    roots: [root],
                    processes: [
                        {
                            pid: child.pid,
                            start: stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19],
                            executable: await readlink(`/proc/${child.pid}/exe`),
                        },
                        { pid: process.pid, start: "0", executable: process.execPath },
                    ],
                }),
                { mode: 0o600 },
            );
            await promisify(execFile)(
                process.execPath,
                ["scripts/vault-linux-evidence.mjs", "cleanup"],
                { env: { ...process.env, VERIQ_VAULT_EVIDENCE: evidence }, timeout: 5000 },
            ).catch(async (error) => {
                process.stderr.write(
                    "VAULT_CLEANUP_OBSERVATION " +
                        (await readFile(join(evidence, "always-cleanup.json"), "utf8")),
                );
                throw error;
            });
            const result = await exited;
            assert.equal(result.signal, "SIGTERM");
            const facts = JSON.parse(await readFile(join(evidence, "always-cleanup.json"), "utf8"));
            assert.deepEqual(facts.errors, []);
            assert.equal(
                facts.observations.find((value: { pid: number }) => value.pid === process.pid)
                    .state,
                "replaced",
            );
            await assert.rejects(readFile(join(root, "anything")), { code: "ENOENT" });
            assert.doesNotThrow(() => process.kill(process.pid, 0));
        } finally {
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
            await exited;
            await rm(root, { recursive: true, force: true });
            await rm(evidence, { recursive: true, force: true });
        }
    },
);
