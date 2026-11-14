/** 本脚本只在临时 Ubuntu CI 中创建一次性专用账户及单个自有 bind 挂载，固定 Node 子程序通过真实文件模式验证重启和清理；状态记录绑定随机身份与实际挂载 inode，正常及 always 清理均拒绝触碰不匹配对象，不修改现有账户或全局挂载。 */
import assert from "node:assert/strict";
import { stageOwnedFixture } from "./restricted-fixture-stage.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID, createHash } from "node:crypto";
import { chmod, chown, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

assert.equal(process.platform, "linux");
assert.equal(process.getuid(), 0);
assert.equal(process.versions.node, "24.22.1");
const [mode, evidence] = process.argv.slice(2);
assert(["test", "cleanup"].includes(mode) && evidence && isAbsolute(evidence));
const runtime = fileURLToPath(new URL("../", import.meta.url));
const statePath = join(evidence, "restricted-file-state.json");
const run = (file, args, extra = {}) =>
    promisify(execFile)(file, args, {
        cwd: runtime,
        timeout: 60000,
        maxBuffer: 128 * 1024,
        encoding: "utf8",
        env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8" },
        ...extra,
    });
const save = (name, value) =>
    writeFile(join(evidence, name), JSON.stringify(value, null, 2) + "\n", { mode: 0o644 });
async function account(name) {
    try {
        const fields = (await run("/usr/bin/getent", ["passwd", name])).stdout.trim().split(":");
        return {
            name: fields[0],
            uid: Number(fields[2]),
            gid: Number(fields[3]),
            comment: fields[4],
            home: fields[5],
            shell: fields[6],
        };
    } catch (error) {
        if (error.code === 2) return undefined;
        throw error;
    }
}
async function group(name) {
    try {
        const fields = (await run("/usr/bin/getent", ["group", name])).stdout.trim().split(":");
        return { name: fields[0], gid: Number(fields[2]), members: fields[3] };
    } catch (error) {
        if (error.code === 2) return undefined;
        throw error;
    }
}
async function mounts() {
    const raw = await readFile("/proc/self/mountinfo", "utf8");
    if (Buffer.byteLength(raw) > 1024 * 1024) throw new Error("FIXTURE_MOUNT_LIMIT");
    return raw
        .trim()
        .split("\n")
        .map((line) => {
            const fields = line.split(" ");
            return {
                id: fields[0],
                path: fields[4].replace(/\\(040|011|012|134)/g, (_all, octal) =>
                    String.fromCharCode(parseInt(octal, 8)),
                ),
                line,
            };
        });
}
async function nobody(uid) {
    for (const flag of ["-u", "-U"]) {
        try {
            await run("/usr/bin/pgrep", [flag, String(uid)]);
            throw new Error("FIXTURE_ACCOUNT_STILL_RUNNING");
        } catch (error) {
            if (error.code !== 1) throw error;
        }
    }
}
async function cleanup(label) {
    let state;
    try {
        state = JSON.parse(await readFile(statePath, "utf8"));
    } catch (error) {
        if (error.code === "ENOENT") {
            await save(`restricted-file-cleanup-${label}.json`, { started: false, errors: [] });
            return;
        }
        throw error;
    }
    const errors = [],
        facts = {
            started: true,
            username: state.username,
            uid: state.uid,
            mountRemoved: false,
            accountRemoved: false,
            groupRemoved: false,
            ownedFilesRemoved: false,
            errors,
        };
    try {
        assert(/^[0-9a-f-]{36}$/.test(state.nonce));
        assert.equal(state.username, "vrf" + state.nonce.replaceAll("-", "").slice(0, 28));
        assert.equal(state.root, join("/var/tmp", "veriq-restricted-ci-" + state.nonce));
        const user = await account(state.username);
        if (user) {
            assert.equal(user.comment, state.nonce);
            assert.equal(user.home, join(state.root, "home"));
            if (state.uid !== undefined) assert.equal(user.uid, state.uid);
            await nobody(user.uid);
        }
        /** 账户名称还不足以授权清理，必须先匹配创建意图中的 passwd 注释、主目录与 UID，且观察不到该真实或有效 UID 的剩余进程；任何未知对象都会保留并记录错误，不能为了清理成功而按名称杀进程或删除别的账户。 */
        const entries = await mounts(),
            nested = entries.filter((entry) => entry.path.startsWith(state.root + "/"));
        assert(
            nested.length <= 1 &&
                nested.every((entry) => entry.path === join(state.root, "volume")),
            "FIXTURE_UNEXPECTED_MOUNT",
        );
        /** 挂载退休必须同时匹配原 mount ID、唯一自有目标及 backing 的实际设备和 inode，避免路径被另一个挂载占用后递归清理；先卸载并再次确认不存在任何嵌套挂载，才允许删除具有随机拥有标记的自有目录。 */
        if (nested.length) {
            if (state.mountId !== undefined) assert.equal(nested[0].id, state.mountId);
            const source = await lstat(join(state.root, "backing")),
                mounted = await lstat(join(state.root, "volume"));
            assert.equal(source.dev, mounted.dev);
            assert.equal(source.ino, mounted.ino);
            assert.equal(await readFile(join(state.root, ".owned"), "utf8"), state.nonce);
            await run("/usr/bin/umount", ["--", join(state.root, "volume")]);
        }
        assert.equal(
            (await mounts()).some((entry) => entry.path.startsWith(state.root + "/")),
            false,
        );
        facts.mountRemoved = true;
        if (user) await run("/usr/sbin/userdel", [state.username]);
        assert.equal(await account(state.username), undefined);
        facts.accountRemoved = true;
        const remainingGroup = await group(state.username);
        if (remainingGroup) {
            assert.equal(remainingGroup.gid, state.gid ?? user?.gid);
            assert.equal(remainingGroup.members, "");
            await run("/usr/sbin/groupdel", [state.username]);
        }
        assert.equal(await group(state.username), undefined);
        facts.groupRemoved = true;
        try {
            assert.equal(await readFile(join(state.root, ".owned"), "utf8"), state.nonce);
            const root = await lstat(state.root);
            assert.equal(root.uid, 0);
            assert(root.isDirectory() && !root.isSymbolicLink());
            await rm(state.root, { recursive: true });
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
        }
        await assert.rejects(lstat(state.root), { code: "ENOENT" });
        facts.ownedFilesRemoved = true;
    } catch (error) {
        errors.push(error instanceof Error ? error.message : "UNKNOWN_ERROR");
    }
    await save(`restricted-file-cleanup-${label}.json`, facts);
    assert.deepEqual(errors, []);
}
if (mode === "cleanup") {
    await cleanup("always");
} else {
    await mkdir(evidence, { recursive: true });
    await assert.rejects(lstat(statePath), { code: "ENOENT" });
    const nonce = randomUUID(),
        state = {
            nonce,
            username: "vrf" + nonce.replaceAll("-", "").slice(0, 28),
            root: join("/var/tmp", "veriq-restricted-ci-" + nonce),
        };
    assert.equal(await account(state.username), undefined);
    assert.equal(await group(state.username), undefined);
    await save("restricted-file-state.json", state);
    const observations = [];
    let staged;
    try {
        await mkdir(state.root, { mode: 0o711 });
        await chmod(state.root, 0o711);
        await writeFile(join(state.root, ".owned"), nonce, { mode: 0o600, flag: "wx" });
        const deployment = JSON.parse(
            await readFile(join(evidence, "restricted-file-deployment.json"), "utf8"),
        );
        assert.equal(deployment.source, join(deployment.root, "runtime"));
        assert.equal(await readFile(join(deployment.root, ".owned"), "utf8"), deployment.nonce);
        staged = join(state.root, "code/apps/runtime");
        await mkdir(join(state.root, "code/apps"), { recursive: true, mode: 0o755 });
        await chmod(join(state.root, "code"), 0o755);
        await chmod(join(state.root, "code/apps"), 0o755);
        const tsconfigBase = await readFile(join(runtime, "../../tsconfig.base.json"));
        const basePath = join(state.root, "code/tsconfig.base.json");
        await writeFile(basePath, tsconfigBase, { flag: "wx", mode: 0o644 });
        await chmod(basePath, 0o644);
        assert.deepEqual(await readFile(basePath), tsconfigBase);
        const inventory = await stageOwnedFixture(deployment.source, staged);
        for (const member of [
            "package.json",
            "src/cli.ts",
            "tests/fixtures/restricted-file-child.ts",
        ]) {
            assert.deepEqual(
                await readFile(join(staged, member)),
                await readFile(join(runtime, member)),
                "FIXTURE_SOURCE_MISMATCH",
            );
        }
        const code = await lstat(staged);
        assert.equal(code.uid, 0);
        assert.equal(code.mode & 0o777, 0o755);
        await save("restricted-file-staging.json", {
            ...inventory,
            root: staged,
            tsconfigBaseSha256: createHash("sha256").update(tsconfigBase).digest("hex"),
            ownerUid: code.uid,
            mode: code.mode & 0o777,
        });
        await run("/usr/sbin/useradd", [
            "--system",
            "--no-create-home",
            "--user-group",
            "--comment",
            nonce,
            "--home-dir",
            join(state.root, "home"),
            "--shell",
            "/usr/sbin/nologin",
            state.username,
        ]);
        const user = await account(state.username);
        assert(user && user.uid > 0);
        Object.assign(state, { uid: user.uid, gid: user.gid });
        await save("restricted-file-state.json", state);
        for (const name of ["backing", "volume", "home"]) {
            const path = join(state.root, name);
            await mkdir(path, { mode: 0o700 });
            await chown(path, user.uid, user.gid);
        }
        await run("/usr/bin/mount", [
            "--bind",
            join(state.root, "backing"),
            join(state.root, "volume"),
        ]);
        const mounted = (await mounts()).filter(
            (entry) => entry.path === join(state.root, "volume"),
        );
        assert.equal(mounted.length, 1);
        state.mountId = mounted[0].id;
        await save("restricted-file-state.json", state);
        await save("restricted-file-context.json", {
            username: state.username,
            uid: user.uid,
            gid: user.gid,
            mount: mounted[0],
            node: process.versions.node,
            sourceNode: process.execPath,
            acceptance:
                "Owned CI bind volume and independent Node restarts; not VM power-loss or deployment durability",
        });
        /** 固定 setpriv 仅将本次新建子进程降到自有专用 UID/GID并清空附加组，不开启 PAM 登录会话；GNU timeout 监督固定 Node 命令，结束后核验该账户无残留进程，真实输出再与账户及主目录来源逐项绑定。 */
        const child = async (phase, args) => {
            const result = await run(
                "/usr/bin/timeout",
                [
                    "--signal=TERM",
                    "--kill-after=5s",
                    "45s",
                    "/usr/bin/setpriv",
                    "--reuid",
                    String(user.uid),
                    "--regid",
                    String(user.gid),
                    "--clear-groups",
                    "--no-new-privs",
                    "--",
                    process.execPath,
                    "--import",
                    "tsx",
                    ...args,
                ],
                {
                    cwd: staged,
                    env: {
                        PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
                        LANG: "C.UTF-8",
                    },
                },
            );
            await nobody(user.uid);
            observations.push({ phase, stdout: result.stdout, stderr: result.stderr, exitCode: 0 });
            await save("restricted-file-observations.json", observations);
            if (phase !== "cli-retire") {
                assert.equal(result.stderr, "");
                const facts = JSON.parse(result.stdout);
                assert.equal(facts.phase, phase);
                assert.equal(facts.codeRoot, staged);
                assert.equal(facts.cwd, staged);
                assert.equal(facts.sourceOwnerUid, 0);
                assert.equal(facts.sourceMode, 0o644);
                assert.equal(facts.uid, user.uid);
                assert.equal(facts.euid, user.uid);
                assert.equal(facts.gid, user.gid);
                assert.equal(facts.egid, user.gid);
                assert.equal(facts.passwdHome, user.home);
                assert.equal(facts.observedHome, user.home);
                assert.equal(facts.homeEnvironmentProvided, false);
                assert.equal(facts.executable, process.execPath);
            } else assert.match(result.stderr, /no encryption at rest/);
        };
        const source = join(staged, "tests/fixtures/restricted-file-child.ts"),
            volume = join(state.root, "volume");
        await child("seed", [source, "seed", volume, String(user.uid)]);
        await child("restart", [source, "restart", volume, String(user.uid)]);
        await child("cli-retire", [
            join(staged, "src/cli.ts"),
            "--config-dir",
            join(volume, "profile"),
            "--credential-mode",
            "restricted-file",
            "--managed-service-uid",
            String(user.uid),
            "--persistent-volume",
            volume,
            "--acknowledge-unencrypted-storage",
            "secret",
            "delete-profile",
            "--confirm-all",
        ]);
        await child("retired", [source, "retired", volume, String(user.uid)]);
        await save("restricted-file-result.json", {
            passed: true,
            stages: observations.map((value) => value.phase),
            username: state.username,
            uid: user.uid,
            mountId: state.mountId,
        });
    } catch (error) {
        await save("restricted-file-failure.json", {
            name: error?.name,
            code: error?.code,
            message: String(error?.message ?? "UNKNOWN_ERROR").slice(0, 2048),
            stdout: String(error?.stdout ?? "").slice(0, 16384),
            stderr: String(error?.stderr ?? "").slice(0, 16384),
        });
        throw error;
    } finally {
        await cleanup("normal");
    }
}
