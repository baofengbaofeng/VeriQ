/** Mac 保险库使用系统 Objective-C++ 编译器生成固定独立成员，测试目标始终位于不同目录且不能进入发行授权；构建同时记录实际编译参数、SDK 依赖文件与二进制身份，Linux 开发机不会下载或伪装 Mac 工具链。 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

if (process.platform !== "darwin" || !["x64", "arm64"].includes(process.arch))
    throw new Error("DARWIN_VAULT_BUILD_TARGET_REQUIRED");
const flags = process.argv.slice(2);
if (
    flags.some((value) => !["--tests", "--red-candidate"].includes(value)) ||
    new Set(flags).size !== flags.length
)
    throw new Error("DARWIN_VAULT_BUILD_ARGUMENT_INVALID");
const red = flags.includes("--red-candidate");
const tests = flags.includes("--tests") || red;
const root = fileURLToPath(new URL("../", import.meta.url));
const execute = async (file, args) =>
    (
        await promisify(execFile)(file, args, {
            cwd: root,
            env: { PATH: "/usr/bin:/bin" },
            timeout: 60_000,
            maxBuffer: 1048576,
            encoding: "utf8",
        })
    ).stdout;
/** 系统 clang++ 可能只是指向 clang 的符号链接，但驱动根据调用名称选择是否隐式链接 C++ 标准库；执行时保留 xcrun 返回的 C++ 驱动名称，规范物理路径仅用于工具身份哈希，不能用身份归一化改变构建语义。 */
const compilerDriver = (await execute("/usr/bin/xcrun", ["--find", "clang++"])).trim();
const compiler = await realpath(compilerDriver);
const sdk = await realpath((await execute("/usr/bin/xcrun", ["--show-sdk-path"])).trim());
const digest = async (path) => ({
    path,
    bytes: (await stat(path)).size,
    sha256: createHash("sha256")
        .update(await readFile(path))
        .digest("hex"),
});
const source = "native/vault/darwin-vault.mm";
const jobs = [
    ...(!red
        ? [
              {
                  name: "production",
                  source,
                  directory: "vault-darwin",
                  member: "veriq_agent",
                  defines: [],
              },
          ]
        : []),
    ...(tests
        ? [
              {
                  name: red ? "test-red-stub" : "test",
                  source,
                  directory: "vault-darwin-test",
                  member: "veriq_agent",
                  defines: ["VERIQ_VAULT_TESTING=1", ...(red ? ["VERIQ_VAULT_RED_STUB=1"] : [])],
              },
              {
                  name: "controller",
                  source: "tests/native/darwin-vault-controller.mm",
                  directory: "vault-darwin-test",
                  member: "veriq_keychain_controller",
                  defines: [],
              },
              {
                  name: "memory",
                  source: "tests/native/darwin-acl-test.mm",
                  directory: "vault-darwin-test",
                  member: "veriq_acl_test",
                  defines: [],
              },
          ]
        : []),
];
const records = [];
for (const job of jobs) {
    const directory = join(root, "build", job.directory);
    await mkdir(directory, { recursive: true });
    const output = join(directory, job.member),
        dependencies = output + ".d";
    const args = [
        "-std=c++17",
        "-fobjc-arc",
        "-O2",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-Wno-deprecated-declarations",
        "-fstack-protector-strong",
        "-mmacosx-version-min=15.0",
        "-isysroot",
        sdk,
        ...job.defines.map((value) => "-D" + value),
        "-MD",
        "-MF",
        dependencies,
        job.source,
        "-framework",
        "Security",
        "-framework",
        "CoreFoundation",
        "-framework",
        "Foundation",
        "-o",
        output,
    ];
    await execute(compilerDriver, args);
    const architecture = (await execute("/usr/bin/lipo", ["-archs", output])).trim();
    const loadCommands = await execute("/usr/bin/otool", ["-l", output]);
    if (
        architecture !== (process.arch === "arm64" ? "arm64" : "x86_64") ||
        !/\bminos 15\.0(?:\.0)?\b/.test(loadCommands)
    )
        throw new Error("DARWIN_VAULT_BUILD_IDENTITY_INVALID");
    const dependencyText = (await readFile(dependencies, "utf8")).replace(/\\\n/g, " ");
    const tokens =
        dependencyText.slice(dependencyText.indexOf(":") + 1).match(/(?:\\.|[^\s])+/g) ?? [];
    const inputs = [
        ...new Set(tokens.map((value) => resolve(root, value.replace(/\\(.)/g, "$1")))),
    ];
    if (inputs.length > 4096) throw new Error("DARWIN_VAULT_BUILD_INPUT_LIMIT");
    if (
        ["test", "test-red-stub", "controller"].includes(job.name) &&
        !inputs.includes(join(root, "native/vault/darwin-read-evidence.hpp"))
    )
        throw new Error("DARWIN_READ_EVIDENCE_BUILD_INPUT_MISSING");
    records.push({
        name: job.name,
        args,
        architecture,
        output: await digest(output),
        inputs: await Promise.all(inputs.map(digest)),
        links: await execute("/usr/bin/otool", ["-L", output]),
        loadCommands,
    });
}
/** 只有显式测试构建才启动已经编译完成的控制器无存储自测，有限子进程必须正常退出并返回精确固定标记；输出错误或异常对象不会直接回显，四成员构建记录及既有编译输入格式保持原样。 */
if (flags.includes("--tests")) {
    let passed = false;
    try {
        const result = await promisify(execFile)(
            join(root, "build/vault-darwin-test/veriq_keychain_controller"),
            ["--read-evidence-selftest"],
            {
                cwd: root,
                env: { PATH: "/usr/bin:/bin" },
                timeout: 5000,
                maxBuffer: 65536,
                encoding: "utf8",
            },
        );
        passed = result.stdout === "DARWIN_READ_EVIDENCE_SELFTEST_PASSED\n" && result.stderr === "";
    } catch {}
    if (!passed) throw new Error("DARWIN_READ_EVIDENCE_SELFTEST_FAILED");
    process.stdout.write("DARWIN_READ_EVIDENCE_SELFTEST_PASSED\n");
}
const facts = {
    boundary: "native-only-no-installed-capability",
    source: process.env.GITHUB_SHA ?? null,
    redCandidate: red,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    compilerDriver,
    compiler: await digest(compiler),
    compilerVersion: await execute(compilerDriver, ["--version"]),
    sdk,
    sdkVersion: (await execute("/usr/bin/xcrun", ["--show-sdk-version"])).trim(),
    records,
};
const evidence = process.env.VERIQ_MAC_EVIDENCE;
if (evidence) {
    await mkdir(evidence, { recursive: true });
    await writeFile(
        join(evidence, red ? "vault-red-build.json" : "vault-build.json"),
        JSON.stringify(facts, null, 4) + "\n",
    );
}
await writeFile(
    join(root, "build", tests ? "vault-darwin-test" : "vault-darwin", "build-facts.json"),
    JSON.stringify(facts, null, 4) + "\n",
);
process.stdout.write(red ? "DARWIN_VAULT_RED_CANDIDATE_BUILT\n" : "DARWIN_VAULT_NATIVE_BUILT\n");
