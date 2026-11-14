/** 构建脚本只在目标 Linux 编译固定保险库辅助程序并记录真实工具与动态库身份，开发宿主不自动安装任何系统依赖；测试提示驱动必须显式启用且输出到独立目录，不能混入正式发行库存。 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

if (process.platform !== "linux" || process.arch !== "x64")
    throw new Error("VAULT_BUILD_PLATFORM_UNSUPPORTED");
const testDriver = process.argv.slice(2).includes("--test-driver");
if (process.argv.slice(2).some((value) => value !== "--test-driver"))
    throw new Error("VAULT_BUILD_ARGUMENT_INVALID");
const root = fileURLToPath(new URL("../", import.meta.url));
const source = join(root, "native/vault/linux-vault.c");
const directory = join(root, "build", testDriver ? "vault-test" : "vault");
const output = join(directory, "veriq_agent");
const env = { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" };
const execute = async (file, args, maxBuffer = 1024 * 1024) =>
    (await promisify(execFile)(file, args, { env, timeout: 60_000, maxBuffer, encoding: "utf8" }))
        .stdout;
const hash = async (path) =>
    createHash("sha256")
        .update(await readFile(path))
        .digest("hex");
const compiler = await realpath("/usr/bin/cc");
const pkgConfig = await realpath("/usr/bin/pkg-config");
const options = (await execute(pkgConfig, ["--cflags", "--libs", "libsecret-1"]))
    .trim()
    .split(/\s+/);
if (options.some((value) => !/^[A-Za-z0-9_./=+,-]+$/.test(value)))
    throw new Error("VAULT_BUILD_FLAGS_INVALID");
const args = [
    "-std=c11",
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-Wformat=2",
    "-D_FORTIFY_SOURCE=2",
    "-fstack-protector-strong",
    "-fPIE",
    "-pie",
    "-Wl,-z,relro,-z,now",
    "-pthread",
    ...(testDriver ? ["-DVERIQ_VAULT_TEST_DRIVER=1"] : []),
    source,
    "-o",
    output,
    ...options,
];
await mkdir(directory, { recursive: true });
await execute(compiler, args);
const evidence = process.env.VERIQ_VAULT_EVIDENCE;
if (evidence) {
    await mkdir(evidence, { recursive: true });
    const prefix = testDriver ? "vault-test" : "vault-production";
    const dependencies = await execute("/usr/bin/ldd", [output]);
    if (/not found/.test(dependencies)) throw new Error("VAULT_LIBRARY_UNRESOLVED");
    const libraries = {};
    for (const line of dependencies.split("\n")) {
        const path = line.match(/(?:=>\s+|^\s*)(\/[^\s]+)/)?.[1];
        if (!path) continue;
        const physical = await realpath(path);
        libraries[path] = {
            physical,
            sha256: await hash(physical),
            bytes: (await stat(physical)).size,
        };
    }
    const record = {
        source: process.env.GITHUB_SHA ?? null,
        sourceFile: source,
        sourceSha256: await hash(source),
        node: process.versions.node,
        platform: process.platform,
        arch: process.arch,
        compiler,
        compilerSha256: await hash(compiler),
        compilerVersion: await execute(compiler, ["--version"]),
        pkgConfig,
        pkgConfigSha256: await hash(pkgConfig),
        pkgConfigVersion: await execute(pkgConfig, ["--version"]),
        libraryVersions: await execute(pkgConfig, [
            "--modversion",
            "libsecret-1",
            "glib-2.0",
            "gio-2.0",
        ]),
        args,
        output,
        sha256: await hash(output),
        bytes: (await stat(output)).size,
        testDriver,
        libraries,
    };
    await writeFile(join(evidence, `${prefix}.json`), JSON.stringify(record, null, 2) + "\n");
    await writeFile(join(evidence, `${prefix}-dependencies.log`), dependencies);
    await writeFile(
        join(evidence, `${prefix}-elf.log`),
        await execute("/usr/bin/readelf", ["-d", "-W", "-s", output]),
    );
}
process.stdout.write(testDriver ? "VAULT_TEST_DRIVER_BUILT\n" : "VAULT_PRODUCTION_HELPER_BUILT\n");
