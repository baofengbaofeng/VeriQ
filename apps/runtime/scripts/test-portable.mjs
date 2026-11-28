import { spawnSync } from "node:child_process";
import { readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

/**
 * 按整文件所需的宿主能力登记根测试。Linux 发行入口构建启动器并执行全部根测试；新文件也须明确开发入口。
 */
const suites = {
    portable: [
        "browser-policy",
        "connected-cli",
        "controlled-proof",
        "darwin-vault-operation-diagnostics",
        "diagnostics",
        "doctor-platform",
        "lease",
        "node-version",
        "offline-legacy-datasets",
        "offline-result",
        "restricted-file",
        "restricted-operation",
        "transport",
        "vault-envelope",
    ],
    posix: [
        "browser-launch-policy",
        // 这些夹具使用真实链接、描述符、UID 与权限位，并通过信号和本机 Unix socket 核验宿主行为。
        "archive-portability",
        "controlled-child",
        "controlled-command",
        "distribution-manifest-v2",
        "pipe-framing",
        "worker-portability",
        // 合成发行树仍使用真实可执行位、链接和 shell shim，需在 POSIX 宿主验证，但不启动目标程序。
        "runtime-assets-acquisition",
        "runtime-assets-observation",
        "runtime-dependency-bytes",
        "runtime-node-bootstrap",
        "runtime-payload-archive",
        "runtime-payload-bins",
        "runtime-payload-entries",
        "runtime-payload-generation",
        "runtime-payload-graph",
        "runtime-payload-inputs",
        "runtime-payload-npm",
        "runtime-payload-receipts",
        "runtime-payload-stage",
        "runtime-payload-transaction",
        "runtime-payload-tree",
    ],
    integration: [
        // 物理领取、恢复与清理经过宿主启动器、/proc、X11 或真实的原生私有目录边界。
        "agent",
        "allocation-recovery",
        "broker-budget",
        "darwin-business-contract",
        "display-environment",
        "guardian-browser",
        "journal-recovery",
        "local-retention",
        "offline-recovery",
        "offline-store",
        "offline",
        "physical",
        "renewal",
        "stop-scope",
        "storage-admission",
        "storage",
        "supervisor",
        "vault-deletion",
        "vault-history",
        "vault-integration",
        "windows-journal-sql",
        // 已安装或源码发行身份、历史 Git 引擎、真实浏览器，以及 Linux 沙箱和凭据 helper。
        "cli-engine-identity",
        "distribution",
        "doctor-distribution",
        "legacy-compiler",
        "restricted-fixture-stage",
        "runtime",
        "trace-native",
        "trace",
        "vault-linux-source",
        "vault-linux",
    ],
};

const root = fileURLToPath(new URL("../", import.meta.url));
const suffix = ".test.ts";
const registered = Object.values(suites).flat();
const pending = new Set(registered);
if (registered.length !== pending.size) throw new Error("Duplicate Runtime test suite assignment");
for (const file of readdirSync(new URL("../tests/", import.meta.url))) {
    if (file.endsWith(suffix) && !pending.delete(file.slice(0, -suffix.length))) {
        throw new Error(`Assign tests/${file} to a Runtime test suite`);
    }
}
if (pending.size) throw new Error(`Missing Runtime test files: ${[...pending].join(", ")}`);

const suite = process.argv[2];
if (suite !== "portable" && suite !== "posix") throw new Error("Expected Runtime suite portable or posix");
if (suite === "posix" && !["linux", "darwin"].includes(process.platform)) {
    throw new Error("Runtime POSIX fixture tests require Linux or macOS");
}
const selected = suites[suite].map((name) => `tests/${name}${suffix}`);
console.log(`Runtime ${suite}: ${selected.length} files. All ${registered.length} root test files run in test:linux.`);
console.log(`Developer suites: test:portable (${suites.portable.length}), test:posix (${suites.posix.length}).`);
// Darwin 的默认临时路径含 /var 软链接，解析后还会令深层 Unix socket 路径超长。夹具在下列根内独占新目录。
const temporary = suite === "posix" && process.platform === "darwin" ? "/tmp" : tmpdir();
const result = spawnSync(process.execPath, ["--import", "tsx", "--test", "--test-concurrency=2", ...selected], {
    cwd: root,
    env: { ...process.env, TMPDIR: realpathSync(temporary) },
    stdio: "inherit",
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
