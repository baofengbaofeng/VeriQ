/** Windows 原生构建是显式开发步骤，binding.gyp 放在 native 子目录避免依赖安装时隐式编译；目标流水线使用已锁定 node-gyp 与官方 Node 头文件，成功后只把两个本次产物复制到 Runtime 开发布局供真实角色测试。 */
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") throw new Error("WINDOWS_NATIVE_BUILD_REQUIRED");
if (
    process.argv.length > 4 ||
    (process.argv[3] !== undefined && process.argv[3] !== "--test-schedules")
)
    throw new Error("NATIVE_BUILD_ARGUMENTS_INVALID");
const testSchedules = process.argv[3] === "--test-schedules";
const root = new URL("../", import.meta.url);
const options = [
    "rebuild",
    "--msvs_version=2022",
    "--directory",
    fileURLToPath(new URL("native/", root)),
];
if (process.argv[2]) options.push(`--devdir=${process.argv[2]}`);
/** 正式构建显式关闭调度及故障测试目标，只有命令行专用参数可编译独立测试二进制；该开关不启用生产 guardian 或 addon 的故障调用和导出，也不会读取全局环境变量来赋予运行时调度能力。 */
options.push("--", `-Dveriq_native_tests=${testSchedules ? 1 : 0}`);
execFileSync(
    process.execPath,
    [fileURLToPath(new URL("node_modules/node-gyp/bin/node-gyp.js", root)), ...options],
    { stdio: "inherit" },
);
await mkdir(new URL("build/Release/", root), { recursive: true });
for (const name of ["veriq_native.node", "veriq_guardian.exe"]) {
    await copyFile(
        new URL(`native/build/Release/${name}`, root),
        new URL(`build/Release/${name}`, root),
    );
}
if (testSchedules) {
    await mkdir(new URL("build/native-tests/", root), { recursive: true });
    for (const name of [
        "veriq_test_schedule.node",
        "veriq_guardian_scheduled.exe",
        "veriq_constructor_fault.node",
        "veriq_response_scheduled.node",
    ]) {
        await copyFile(
            new URL(`native/build/Release/${name}`, root),
            new URL(`build/native-tests/${name}`, root),
        );
    }
}

/** 只有构建流水线显式指定证据目录时才运行 SDK 导入诊断，工具来自现有 vswhere 解析出的真实 VS 安装；固定 addon 名单、参数数组与输出上限阻止任意命令或二进制采集，普通产品运行不读取此开关。 */
if (process.env.VERIQ_NATIVE_EVIDENCE) {
    const evidence = process.env.VERIQ_NATIVE_EVIDENCE;
    const programFiles = process.env["ProgramFiles(x86)"];
    if (!programFiles) throw new Error("NATIVE_IMPORT_TOOL_UNAVAILABLE");
    const vswhere = join(programFiles, "Microsoft Visual Studio/Installer/vswhere.exe");
    const installation = execFileSync(
        vswhere,
        [
            "-latest",
            "-products",
            "*",
            "-requires",
            "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
            "-property",
            "installationPath",
        ],
        { encoding: "utf8", timeout: 10000, maxBuffer: 65536 },
    ).trim();
    if (!installation || /[\r\n]/.test(installation))
        throw new Error("NATIVE_IMPORT_TOOL_UNAVAILABLE");
    const toolVersion = (
        await readFile(
            join(installation, "VC/Auxiliary/Build/Microsoft.VCToolsVersion.default.txt"),
            "utf8",
        )
    ).trim();
    if (!/^\d+\.\d+\.\d+$/.test(toolVersion)) throw new Error("NATIVE_IMPORT_TOOL_UNAVAILABLE");
    const dumpbin = join(installation, "VC/Tools/MSVC", toolVersion, "bin/Hostx64/x64/dumpbin.exe");
    const versionOutput = execFileSync(dumpbin, ["/?"], {
        encoding: "utf8",
        timeout: 10000,
        maxBuffer: 256 * 1024,
    });
    const version = versionOutput.split(/\r?\n/).find((line) => /Version [0-9.]+/.test(line));
    if (!version) throw new Error("NATIVE_IMPORT_TOOL_VERSION_UNAVAILABLE");
    /** 工具和被检查模块仅流式计算摘要，记录与本次实际导入输出绑定的字节身份；既不复制系统 DLL，也不把工具版本字符串误认为编译器、运行库或所有目标系统都已固定到相同版本。 */
    const hash = async (path) => {
        const digest = createHash("sha256");
        for await (const bytes of createReadStream(path)) digest.update(bytes);
        return digest.digest("hex");
    };
    const targets = [];
    for (const name of [
        "veriq_native.node",
        ...(testSchedules ? ["veriq_constructor_fault.node", "veriq_response_scheduled.node"] : []),
    ]) {
        const path = fileURLToPath(new URL(`native/build/Release/${name}`, root));
        const imports = execFileSync(dumpbin, ["/nologo", "/imports", path], {
            encoding: "utf8",
            timeout: 10000,
            maxBuffer: 256 * 1024,
        });
        await writeFile(join(evidence, `${name}.imports.log`), imports);
        const matched =
            /ntdll\.dll/i.test(imports) &&
            /\bNtCreateFile\b/.test(imports) &&
            /\bRtlNtStatusToDosError\b/.test(imports);
        targets.push({ name, sha256: await hash(path), matched });
    }
    await writeFile(
        join(evidence, "native-imports.json"),
        JSON.stringify({ dumpbin, version, toolSha256: await hash(dumpbin), targets }, null, 4) +
            "\n",
    );
    if (targets.some((target) => !target.matched))
        throw new Error("NATIVE_PRIVATE_IMPORTS_MISSING");
}
