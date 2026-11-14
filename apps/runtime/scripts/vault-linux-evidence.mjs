/** 目标验证证据脚本仅采集本次选定系统包与真实源码身份，清理只依据自有登记中的 PID 创建时间和程序路径；既不上传密码或 keyring 内容，也不按进程名称终止系统总线与其他用户的凭据服务。 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rm, statfs, writeFile } from "node:fs/promises";
import { join, basename, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const directory = process.env.VERIQ_VAULT_EVIDENCE;
if (!directory || process.platform !== "linux") throw new Error("VAULT_EVIDENCE_CONTEXT_REQUIRED");
await mkdir(directory, { recursive: true });
const mode = process.argv[2];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const run = async (file, args, maxBuffer = 4 * 1024 * 1024) =>
    (
        await promisify(execFile)(file, args, {
            timeout: 60_000,
            maxBuffer,
            encoding: "utf8",
            env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
        })
    ).stdout;
const save = async (name, value) =>
    writeFile(join(directory, name), JSON.stringify(value, null, 2) + "\n");

if (mode === "packages") {
    const raw = await run("/usr/bin/dpkg-query", [
        "-W",
        "-f=${binary:Package}\t${Version}\t${Architecture}\t${source:Package}\t${source:Version}\t${Depends}\t${Pre-Depends}\t${Provides}\t${Installed-Size}\n",
    ]);
    const installed = new Map();
    const providers = new Map();
    const nameOf = (name) => name.replace(/:(?:any|native|amd64|all)$/, "");
    for (const line of raw.trim().split("\n")) {
        const [
            binary,
            version,
            arch,
            source,
            sourceVersion,
            depends,
            preDepends,
            provides,
            installedKiB,
        ] = line.split("\t");
        const name = nameOf(binary);
        const record = {
            binary,
            version,
            arch,
            source,
            sourceVersion,
            depends,
            preDepends,
            provides,
            installedKiB,
        };
        installed.set(name, record);
        for (const item of (provides ?? "").split(",")) {
            const virtual = item.trim().split(/[ (]/)[0];
            if (virtual) providers.set(virtual, [...(providers.get(virtual) ?? []), name]);
        }
    }
    const closure = (roots) => {
        const pending = [...roots],
            result = new Set();
        while (pending.length) {
            const name = pending.pop();
            if (result.has(name)) continue;
            const record = installed.get(name);
            if (!record) throw new Error("VAULT_PACKAGE_CLOSURE_UNRESOLVED");
            result.add(name);
            for (const group of `${record.depends},${record.preDepends}`.split(",")) {
                if (!group.trim()) continue;
                const matches = [];
                for (const alternative of group.split("|")) {
                    const candidate = nameOf(alternative.trim().split(/[ (]/)[0]);
                    if (installed.has(candidate)) matches.push(candidate);
                    else matches.push(...(providers.get(candidate) ?? []));
                }
                if (!matches.length) throw new Error("VAULT_PACKAGE_CLOSURE_UNRESOLVED");
                pending.push(...matches);
            }
        }
        return [...result].sort();
    };
    const runtime = closure(["libsecret-1-0", "gnome-keyring", "dbus"]);
    const build = closure(["gcc", "libc6-dev", "pkg-config", "libsecret-1-dev", "libglib2.0-bin"]);
    const records = {};
    for (const name of new Set([...runtime, ...build])) {
        const record = installed.get(name);
        let catalog;
        try {
            catalog = await run(
                "/usr/bin/apt-cache",
                ["show", `${record.binary}=${record.version}`],
                1024 * 1024,
            );
        } catch {
            catalog = null;
        }
        const copyrightPath = `/usr/share/doc/${name}/copyright`;
        let license;
        try {
            const bytes = await readFile(copyrightPath);
            if (bytes.length > 1024 * 1024) throw new Error();
            license = { path: copyrightPath, sha256: hash(bytes), text: bytes.toString("utf8") };
        } catch {
            license = { path: copyrightPath, unavailable: true };
        }
        records[name] = { ...record, catalog, license };
    }
    const releases = {};
    for (const name of await readdir("/var/lib/apt/lists"))
        if (name.endsWith("_InRelease"))
            releases[name] = hash(await readFile(join("/var/lib/apt/lists", name)));
    let security;
    try {
        security = {
            exit: 0,
            output: await run("/usr/bin/pro", ["security-status", "--format", "json"]),
        };
    } catch (error) {
        security = {
            exit: error.code ?? null,
            available: false,
            meaning: "No security clearance inferred from unavailable command",
        };
    }
    await save("system-packages.json", {
        osRelease: await readFile("/etc/os-release", "utf8"),
        uname: await run("/usr/bin/uname", ["-a"]),
        architecture: process.arch,
        aptInReleaseHashes: releases,
        runtimeClosure: runtime,
        buildClosure: build,
        unresolvedCatalogs: Object.entries(records)
            .filter(([, record]) => !record.catalog)
            .map(([name]) => name),
        unresolvedLicenses: Object.entries(records)
            .filter(([, record]) => record.license.unavailable)
            .map(([name]) => name),
        alternativePolicy:
            "Conservatively includes every installed alternative/provider; not a minimal package graph",
        records,
        security,
    });
} else if (mode === "source") {
    const root = resolve("../..");
    const names = (
        await run("/usr/bin/git", [
            "-C",
            root,
            "ls-files",
            "apps/runtime",
            "packages",
            "pnpm-lock.yaml",
            ".github/workflows/runtime-vault-linux.yml",
        ])
    )
        .trim()
        .split("\n");
    const files = {};
    for (const name of names) files[name] = hash(await readFile(join(root, name)));
    const disk = await statfs(root, { bigint: true });
    const finalFreeBytes = disk.bavail * disk.bsize;
    await save("source-binding.json", {
        source: process.env.GITHUB_SHA,
        files,
        node: process.versions.node,
        finalFreeBytes: finalFreeBytes.toString(),
        requiredReserveBytes: "2147483648",
        acceptance: "Private Ubuntu CI Secret Service; not installed desktop acceptance",
    });
    if (finalFreeBytes < 2147483648n) throw new Error("VAULT_BUILD_DISK_RESERVE_EXHAUSTED");
} else if (mode === "cleanup") {
    const helper = new URL("./vault-linux-cleanup.py", import.meta.url);
    let checked;
    try {
        checked = JSON.parse(
            await run(
                "/usr/bin/python3",
                ["-I", fileURLToPath(helper), join(directory, "fixture-ownership.json")],
                256 * 1024,
            ),
        );
        if (
            !Array.isArray(checked.observations) ||
            !Array.isArray(checked.errors) ||
            !Array.isArray(checked.ownedRoots)
        )
            throw new Error("VAULT_PIDFD_RESULT_INVALID");
        checked.pidfd = {
            ...checked.pidfd,
            executable: await realpath("/usr/bin/python3"),
            executableSha256: hash(await readFile("/usr/bin/python3")),
            helperSha256: hash(await readFile(helper)),
        };
    } catch {
        checked = {
            registryPresent: false,
            observations: [],
            ownedRoots: [],
            errors: ["VAULT_PIDFD_TOOL_UNAVAILABLE"],
            pidfd: { supported: false },
        };
    }
    const { observations, errors } = checked;
    const roots = [];
    if (!errors.length)
        for (const path of checked.ownedRoots) {
            try {
                if (
                    dirname(path) !== tmpdir() ||
                    !["veriq-vault-session-", "veriq vault 中文 "].some((prefix) =>
                        basename(path).startsWith(prefix),
                    )
                )
                    throw new Error("VAULT_CLEANUP_ROOT_INVALID");
                const info = await lstat(path);
                if (
                    !info.isDirectory() ||
                    info.isSymbolicLink() ||
                    info.uid !== process.getuid() ||
                    info.mode & 0o077
                )
                    throw new Error("VAULT_CLEANUP_ROOT_UNOWNED");
                await rm(path, { recursive: true, force: true });
                roots.push({ path, removed: true });
            } catch (error) {
                if (error.code === "ENOENT") roots.push({ path, alreadyAbsent: true });
                else errors.push(error.message);
            }
        }
    await save("always-cleanup.json", {
        registryPresent: checked.registryPresent,
        observations,
        roots,
        errors,
        pidfd: checked.pidfd,
    });
    if (errors.length) throw new Error("VAULT_CLEANUP_FAILED");
} else throw new Error("VAULT_EVIDENCE_MODE_INVALID");
