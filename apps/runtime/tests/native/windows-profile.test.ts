/** Windows 档案组成测试通过真实库创建、设备公开 API、安装库存和独立角色进程验证权限边界；所有文件与合成令牌都属于临时测试根，不读取真实档案，也不把单个 ACL 检查替代实际提交失败后的原字节和生命周期证明。 */
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
    mkdtemp,
    mkdir,
    writeFile,
    readFile,
    readdir,
    rm,
    copyFile,
    realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import lockfile from "proper-lockfile";
import { windowsNative } from "../../src/native/windows.ts";
import { privateDirectory, readPrivate, updatePrivate } from "../../src/offline/config.ts";
import { DeviceStore } from "../../src/enrollment.ts";
import { LocalStore } from "../../src/offline/store.ts";
import { loadRuntimeDistribution } from "../../src/distribution.ts";

assert.equal(process.platform, "win32");
const native = windowsNative();
const powershell = join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe");
const powershellEnvironment = {
    ...Object.fromEntries(
        Object.entries(process.env).filter(([name]) => name.toLowerCase() !== "psmodulepath"),
    ),
    PSModulePath: join(dirname(powershell), "Modules"),
};
const encoded = (script: string) => [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64"),
];
const device = {
    server: "http://127.0.0.1:1",
    runnerId: "11111111-1111-4111-8111-111111111111",
    workspaceId: "22222222-2222-4222-8222-222222222222",
    deviceToken: "synthetic-owned-profile-token",
    expiresAt: "2099-01-01T00:00:00Z",
};

/** 自有辅助进程的就绪与退出分别具有有限等待，超时只作为测试失败而不冒充释放成功；调用者仍负责关闭自己持有的输入端并记录真实退出，不把计时器触发等价为文件句柄已经关闭。 */
async function bounded<T>(operation: Promise<T>, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            operation,
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error(label)), 10000);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

/** 临时根由当前测试唯一持有，失败保留合成档案供 CI 诊断，成功才删除；持有子进程或数据库的场景必须先在自身 finally 完成关闭，不能用递归删除或强杀掩盖未退出的资源。 */
async function fixture(context: TestContext, run: (root: string) => Promise<void>) {
    const root = await mkdtemp(join(tmpdir(), "veriq profile 中文 "));
    try {
        await run(root);
        await rm(root, { recursive: true, force: true });
    } catch (error) {
        context.diagnostic(`Owned profile evidence retained: ${root}`);
        throw error;
    }
}

/** 独立的 Windows ACL 查询只读取测试成员的真实安全描述符，校验每个允许项属于当前 SID 且来自继承；这证明库创建时收到父目录权限，而非原生检查器与被测实现相互重复断言。 */
async function inheritedAcl(paths: string[]) {
    const { stdout } = await promisify(execFile)(
        powershell,
        encoded(`
$ErrorActionPreference='Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$paths = ConvertFrom-Json $env:VERIQ_OWNED_PATHS
$pipelineInputs = @(ConvertFrom-Json $env:VERIQ_OWNED_PATHS | ForEach-Object {
    @{ type=$_.GetType().FullName; count=@($_).Count }
})
$records = @(foreach ($path in $paths) {
    if ($path -isnot [string]) { throw 'OWNED_ACL_PATH_NOT_STRING' }
    $acl = if ([System.IO.Directory]::Exists($path)) { [System.IO.Directory]::GetAccessControl($path) } else { [System.IO.File]::GetAccessControl($path) }
    $rules = @($acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]) | ForEach-Object {
        @{ sid=$_.IdentityReference.Value; inherited=$_.IsInherited; allow=($_.AccessControlType -eq 'Allow') }
    })
    @{ path=$path; inputType=$path.GetType().FullName; owner=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value; rules=$rules }
})
ConvertTo-Json -InputObject @{ inputCount=@($paths).Count; pipelineInputs=$pipelineInputs; records=$records } -Depth 5 -Compress
`),
        {
            env: { ...powershellEnvironment, VERIQ_OWNED_PATHS: JSON.stringify(paths) },
            timeout: 10000,
            maxBuffer: 65536,
            windowsHide: true,
        },
    );
    const observed = JSON.parse(stdout) as {
        inputCount: number;
        pipelineInputs: Array<{ type: string; count: number }>;
        records: Array<{
            path: string;
            inputType: string;
            owner: string;
            rules: Array<{ sid: string; inherited: boolean; allow: boolean }>;
        }>;
    };
    console.log(`Owned ACL probe before assertions: ${JSON.stringify(observed)}`);
    assert.equal(observed.inputCount, paths.length);
    assert.equal(observed.records.length, paths.length);
    assert.equal(new Set(paths).size, paths.length);
    assert.deepEqual(
        observed.records.map((record) => record.path),
        paths,
    );
    for (const record of observed.records) {
        assert.equal(record.inputType, "System.String");
        assert.equal(record.owner, native.sid);
        assert(record.rules.length > 0);
        for (const rule of record.rules)
            assert.deepEqual(rule, { sid: native.sid, inherited: true, allow: true });
    }
    return observed;
}

/** Node、SQLite 与 proper-lockfile 都使用自身正常创建流程，父目录从创建起提供当前 SID 继承；实际子文件能被有限私有接口接受，SQLite WAL 和锁目录也不能短暂借用公共默认 ACL。 */
test("Windows private profile inherits ACLs into Node SQLite and lockfile children", async (context) => {
    await fixture(context, async (root) => {
        const profile = join(root, "profile");
        await privateDirectory(profile);
        const ordinary = join(profile, "node.json");
        await writeFile(ordinary, '{"owned":true}');
        const store = await LocalStore.open(join(profile, "local"));
        try {
            const release = await lockfile.lock(join(profile, "local"), {
                realpath: false,
                retries: 0,
            });
            try {
                const children = [
                    ordinary,
                    join(profile, "local.lock"),
                    join(profile, "local/veriq.sqlite"),
                    join(profile, "local/veriq.sqlite-wal"),
                    join(profile, "local/veriq.sqlite-shm"),
                ];
                context.diagnostic(
                    `Inherited child ACLs: ${JSON.stringify(await inheritedAcl(children))}`,
                );
                assert.deepEqual(await readPrivate(profile, "node.json"), { owned: true });
                for (const path of children) native.privatePath(path, false);
            } finally {
                await release();
            }
        } finally {
            store.close();
        }
    });
});

/** 设备保存通过真实 DeviceStore 完成，创建时权限与已有设备排他均属于公开合同；合成令牌只存在自有临时文件，测试不注册设备、不访问网络，也不把后续收紧权限视为首次创建成功。 */
test("Windows DeviceStore creates private credentials and refuses a second enrollment", async (context) => {
    await fixture(context, async (root) => {
        const store = new DeviceStore(join(root, "device"));
        await store.save(device);
        native.privatePath(store.directory, false);
        native.privatePath(join(store.directory, "device.json"), false);
        assert.deepEqual(await store.load(), device);
        await assert.rejects(
            store.save({ ...device, deviceToken: "synthetic-second" }),
            /ALREADY_ENROLLED/,
        );
        assert.deepEqual(await store.load(), device);
        await store.remove();
        await assert.rejects(store.load(), { code: "ENOENT" });
    });
});

/** 先用原生私有创建建立合法设备并实际读取，再由系统 icacls 仅给自有合成文件增加 World 读取权限；公开加载必须拒绝这个已经证实不私有的对象，不能继续把 Windows 模式检查跳过当成授权。 */
test("Windows DeviceStore rejects existing public credentials without changing bytes", async (context) => {
    await fixture(context, async (root) => {
        const profile = join(root, "profile");
        await privateDirectory(profile);
        const path = join(profile, "device.json");
        native.writePrivate(path, JSON.stringify(device));
        const store = new DeviceStore(profile);
        assert.deepEqual(await store.load(), device);
        await promisify(execFile)(
            join(process.env.SystemRoot!, "System32/icacls.exe"),
            [path, "/grant", "*S-1-1-0:(R)"],
            { timeout: 5000, maxBuffer: 65536, windowsHide: true },
        );
        assert.throws(() => native.privatePath(path, false), /NATIVE_ACL_NOT_PRIVATE/);
        const before = await readFile(path);
        const results = await Promise.allSettled([
            assert.rejects(store.load(), /NATIVE_ACL_NOT_PRIVATE|Unsafe device/),
            assert.rejects(store.remove(), /NATIVE_ACL_NOT_PRIVATE/),
        ]);
        results.push(
            ...(await Promise.allSettled([
                readFile(path).then((bytes) => assert.deepEqual(bytes, before)),
            ])),
        );
        assert.deepEqual(
            results.filter((result) => result.status === "rejected"),
            [],
        );
    });
});

/** 独立进程用真实 FileShare.Read 保持正式文件打开，允许旧代读取而禁止 rename 删除共享；首次更新失败必须保留字节、只执行一次回调并清理自有临时成员，释放真实句柄后同一 API 才能成功发布下一代。 */
test("Windows private update preserves the old generation on a real sharing-denied commit", async (context) => {
    await fixture(context, async (root) => {
        const profile = join(root, "profile"),
            name = "descriptor.json";
        await updatePrivate(profile, name, () => ({ generation: 1 }));
        const path = join(profile, name),
            before = await readFile(path);
        const child = spawn(
            powershell,
            encoded(`
$ErrorActionPreference='Stop'
$file=[System.IO.File]::Open($env:VERIQ_OWNED_FILE,[System.IO.FileMode]::Open,[System.IO.FileAccess]::Read,[System.IO.FileShare]::Read)
try { [Console]::Out.WriteLine('HELD'); [Console]::Out.Flush(); [Console]::In.ReadLine() | Out-Null }
finally { $file.Dispose() }
`),
            {
                env: { ...powershellEnvironment, VERIQ_OWNED_FILE: path },
                stdio: ["pipe", "pipe", "pipe"],
                windowsHide: true,
            },
        );
        const exited = once(child, "exit");
        void exited.catch(() => {});
        let output = "",
            errors = "";
        child.stdin.on("error", (error) => {
            errors += error.message;
        });
        child.stderr.on("data", (chunk) => {
            errors += chunk.toString();
        });
        const held = new Promise<void>((resolve, reject) => {
            child.once("error", reject);
            child.once("exit", () => reject(new Error("OWNED_HOLDER_EXITED_BEFORE_READY")));
            child.stdout.on("data", (chunk) => {
                output += chunk.toString();
                if (output.includes("HELD")) resolve();
            });
        });
        const failures: unknown[] = [];
        try {
            await bounded(held, "OWNED_HOLDER_READY_TIMEOUT");
            let callbacks = 0;
            try {
                await assert.rejects(
                    updatePrivate(profile, name, (old) => {
                        callbacks++;
                        assert.deepEqual(old, { generation: 1 });
                        return { generation: 2 };
                    }),
                    /NATIVE_PRIVATE_COMMIT_FAILED/,
                );
            } catch (error) {
                failures.push(error);
            }
            for (const check of [
                async () => assert.equal(callbacks, 1),
                async () => assert.deepEqual(await readFile(path), before),
                async () => assert.deepEqual(await readdir(profile), [name]),
            ]) {
                try {
                    await check();
                } catch (error) {
                    failures.push(error);
                }
            }
        } catch (error) {
            failures.push(error);
        } finally {
            child.stdin.end("RELEASE\n");
            try {
                const [code, signal] = await bounded(exited, "OWNED_HOLDER_EXIT_TIMEOUT");
                if (code !== 0 || signal !== null || errors)
                    failures.push(
                        new Error(`OWNED_HOLDER_EXIT_FAILED ${code}/${signal}/${errors}`),
                    );
            } catch (error) {
                failures.push(error);
            }
        }
        if (failures.length)
            throw new AggregateError(failures, "SHARING_DENIED_COMMIT_CHECK_FAILED");
        await updatePrivate(profile, name, (old) => {
            assert.deepEqual(old, { generation: 1 });
            return { generation: 2 };
        });
        assert.deepEqual(await readPrivate(profile, name), { generation: 2 });
        context.diagnostic(
            "Actual sharing-denied commit retained bytes; holder exited naturally before successful replacement",
        );
    });
});

/** 合成发行沿用现有库存格式，仅角色 Node 和 addon 使用真实本次二进制，其余占位成员不执行；这验证库存绑定与私有访问顺序，不把小型布局夹具冒充完整浏览器或正式安装包验收。 */
async function distribution(root: string, includeNative: boolean) {
    const directory = join(root, "installed"),
        files = [];
    const names = [
        "roles/agent/veriq_agent.exe",
        "roles/runner/veriq_runner.exe",
        "roles/cli/veriq_cli.exe",
        "native/veriq_runner.exe",
        "entry/agent.js",
        "entry/cli.js",
        "execution/worker.mjs",
        "execution/provider.mjs",
        "execution/compile-entry.mjs",
        "execution/archive.mjs",
        "npm/bin/npm-cli.js",
        "node_modules/tsx/dist/loader.mjs",
        "browser/chrome-win64/chrome.exe",
        "engines/1.0.3-t20/inventory.json",
    ];
    if (includeNative) names.push("native/veriq_native.node");
    for (const path of names) {
        const target = join(directory, path);
        await mkdir(dirname(target), { recursive: true });
        if (path === "roles/agent/veriq_agent.exe") await copyFile(process.execPath, target);
        else if (path === "native/veriq_native.node")
            await copyFile(
                fileURLToPath(new URL("../../build/Release/veriq_native.node", import.meta.url)),
                target,
            );
        else await writeFile(target, path);
        const hash = createHash("sha256");
        let sizeBytes = 0;
        for await (const bytes of createReadStream(target)) {
            hash.update(bytes);
            sizeBytes += bytes.length;
        }
        files.push({ path, sizeBytes, sha256: hash.digest("hex") });
    }
    await writeFile(
        join(directory, "runtime-manifest.json"),
        JSON.stringify({
            schemaVersion: 1,
            productVersion: "1.0.0-dev.t20",
            nodeVersion: "24.22.1",
            platform: "win32",
            arch: process.arch,
            engineVersion: "1.0.3-t20",
            files,
        }),
    );
    return await realpath(directory);
}

/** 缺少原生模块的 Windows 库存不能完成可信启动，即使源码树碰巧有可加载 addon 也必须拒绝；这是安装分支所需成员检查，不改变明确开发模式或把环境中的全局模块作为安装回退。 */
test("Windows distribution rejects a missing native capability before private profile access", async (context) => {
    await fixture(context, async (root) => {
        const installed = await distribution(root, false);
        await assert.rejects(loadRuntimeDistribution(installed), /RUNTIME_MEMBER_MISSING/);
    });
});

/** 独立重命名 Agent Node 在干净模块缓存中核验真实库存并访问自有私有档案，随后检查实际加载的 addon 物理路径；源码开发 addon 即使存在也不能代替已核验安装成员，且路径不来自档案内容。 */
test("Windows verified distribution binds its actual addon before private profile access", async (context) => {
    await fixture(context, async (root) => {
        const installed = await distribution(root, true),
            profile = join(root, "profile");
        const script = `
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { loadRuntimeDistribution, assertRuntimeRole } from ${JSON.stringify(new URL("../../src/distribution.ts", import.meta.url).href)};
import { updatePrivate, readPrivate } from ${JSON.stringify(new URL("../../src/offline/config.ts", import.meta.url).href)};
const installed = await loadRuntimeDistribution(process.argv[1]);
assertRuntimeRole(installed, 'agent');
await updatePrivate(process.argv[2], 'descriptor.json', () => ({bound:true}));
assert.deepEqual(await readPrivate(process.argv[2], 'descriptor.json'), {bound:true});
const loaded = Object.keys(createRequire(import.meta.url).cache).filter(path => path.endsWith('.node'));
assert.deepEqual(loaded, [process.argv[3]]);
console.log(JSON.stringify({role:process.execPath, native:loaded, privateRead:true}));
`;
        const { stdout, stderr } = await promisify(execFile)(
            join(installed, "roles/agent/veriq_agent.exe"),
            [
                "--import",
                import.meta.resolve("tsx"),
                "--input-type=module",
                "-e",
                script,
                installed,
                profile,
                join(installed, "native/veriq_native.node"),
            ],
            { timeout: 15000, maxBuffer: 65536, windowsHide: true },
        );
        assert.equal(stderr, "");
        context.diagnostic(`Actual verified role capability: ${stdout.trim()}`);
    });
});
