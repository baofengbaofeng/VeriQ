import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, statfs, writeFile, lstat } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import "../../apps/runtime/scripts/runtime-payload-inputs.ts";
import { ASSET_SOURCES } from "../../apps/runtime/scripts/runtime-assets-observation.ts";
import { runBoundedAssetCli } from "../../apps/runtime/scripts/runtime-assets-ci-process.mjs";

const env = process.env,
    root = env.ASSET_ROOT,
    meta = join(root, "metadata");
const identity = {
    commit: env.GITHUB_SHA,
    runId: env.GITHUB_RUN_ID,
    runAttempt: Number(env.GITHUB_RUN_ATTEMPT),
    arch: env.EXPECTED_ARCH,
};
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const ref = (path, bytes) => ({ path, sizeBytes: bytes.length, sha256: hash(bytes) });
async function put(path, bytes) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
}
const json = (path, value) => put(path, Buffer.from(JSON.stringify(value)));
async function committed(path, file = resolve(env.GITHUB_WORKSPACE, path)) {
    const bytes = await readFile(file);
    const expected = execFileSync("git", ["-C", env.GITHUB_WORKSPACE, "show", identity.commit + ":" + path], {
        maxBuffer: 8 * 1024 ** 2,
    });
    assert.ok(bytes.equals(expected), "CI source differs from checkout commit: " + path);
    return bytes;
}
async function bind(stage) {
    const files = [];
    for (const [i, path] of [
        "apps/runtime/scripts/runtime-assets-ci-process.mjs",
        "apps/runtime/tests/runtime-assets-ci-process.test.mjs",
    ].entries()) {
        const bytes = await committed(path);
        files.push(ref(path, bytes));
        if (stage === "unit") await put(join(meta, "ci-process", i ? "test.mjs" : "helper.mjs"), bytes);
    }
    await json(join(meta, "ci-process/binding-" + stage + ".json"), {
        kind: "ASSET_CI_PROCESS_SOURCE",
        ...identity,
        ciProcessRefs: files,
    });
}
async function run(args, stdoutPath, stderrPath) {
    const started = Date.now();
    const {
        stdout,
        stderr,
        pid: _pid,
        ...execution
    } = await runBoundedAssetCli({
        executable: process.execPath,
        args,
        cwd: process.cwd(),
        timeoutMs: 16 * 60000,
    });
    const journal = {
        ...execution,
        elapsedMs: Date.now() - started,
        argv: [process.execPath, ...args],
        cwd: process.cwd(),
    };
    await put(join(meta, stdoutPath), stdout);
    await put(join(meta, stderrPath), stderr);
    return { stdout, stderr, journal };
}
function successful({ journal }) {
    return (
        journal.admitted &&
        journal.closeConfirmed &&
        !journal.truncated &&
        !journal.timedOut &&
        journal.exit === 0 &&
        journal.signal === null &&
        journal.error === null
    );
}
function summary(step, result, receiptKind, directory) {
    if (successful(result)) {
        const document = JSON.parse(result.stdout.toString("utf8"));
        assert.equal(document.kind, receiptKind);
        assert.equal(document.directory, directory);
        assert.equal(document.committed, true);
        assert.equal(document.cleanup, "CONFIRMED");
        return { step, status: "PASS", code: null, cleanup: document.cleanup, actualBytes: null };
    }
    const reason = result.stderr
        .toString("utf8")
        .match(/^(PAYLOAD_[A-Z_]+) phase=([A-Z_]+) cleanup=(CONFIRMED|INCOMPLETE|NOT_NEEDED)$/m);
    return {
        step,
        status: "FAIL",
        code: reason?.[1] ?? null,
        phase: reason?.[2] ?? null,
        cleanup: reason?.[3] ?? null,
        actualBytes: null,
    };
}
const paused = (step, reason) => ({
    step,
    status: "NOT_RUN",
    reason,
    admitted: false,
    closeConfirmed: null,
    truncated: false,
    timedOut: false,
    exit: null,
    signal: null,
    elapsedMs: 0,
    code: null,
    phase: null,
    cleanup: null,
    argv: null,
    cwd: null,
    error: null,
});
async function copyMetadata(from, to) {
    const stat = await lstat(from);
    assert.ok(stat.isFile() && stat.nlink === 1 && stat.size <= 4 * 1024 ** 2);
    await put(to, await readFile(from));
}
async function unit() {
    await bind("unit");
    const result = await run(
        ["--test", "tests/runtime-assets-ci-process.test.mjs"],
        "unit.stdout.log",
        "unit.stderr.log",
    );
    await json(join(meta, "unit.json"), {
        ...result.journal,
        step: "UNIT",
        status: successful(result) ? "PASS" : "FAIL",
        reason: null,
        code: null,
        phase: null,
        cleanup: null,
    });
    assert.ok(successful(result), "unit execution failed");
}
async function observe() {
    await bind("observe");
    assert.equal(process.platform, "darwin");
    assert.equal(process.arch, identity.arch);
    assert.equal(process.versions.node, "24.22.1");
    const osVersion = execFileSync("/usr/bin/sw_vers", ["-productVersion"], { encoding: "utf8" }).trim();
    assert.match(osVersion, /^15\.[0-9]+(?:\.[0-9]+)?$/);
    const files = [];
    for (const { path, url } of ASSET_SOURCES) files.push(ref(path, await committed(path, fileURLToPath(url))));
    const facts = Buffer.from(
        JSON.stringify({
            schemaVersion: 1,
            kind: "ASSET_OBSERVER_SOURCE",
            ...identity,
            osVersion,
            nodeVersion: process.versions.node,
            nodeSha256: hash(await readFile(process.execPath)),
            files,
        }),
    );
    await put(join(meta, "source.json"), facts);
    const factsPath = "evidence/source.json";
    await put(join(root, "source", factsPath), facts);
    await json(join(root, "source-observation.json"), { commit: identity.commit, evidence: ref(factsPath, facts) });
    for (const name of ["acquisition", "observation", "bootstrap"]) await mkdir(join(root, name), { mode: 0o700 });
    const acquire = await run(
        [
            "--import",
            "tsx",
            "scripts/acquire-macos-runtime-assets.mjs",
            "--arch",
            identity.arch,
            "--source",
            join(root, "source-observation.json"),
            "--input-root",
            join(root, "source"),
            "--output-parent",
            join(root, "acquisition"),
            "--candidate",
            "acquired",
        ],
        "acquisition/result.json",
        "acquisition/prepare.log",
    );
    const acquired = join(root, "acquisition/acquired");
    const steps = [summary("ACQUIRE", acquire, "MAC_RUNTIME_ASSETS_ACQUISITION_RESULT", acquired)];
    let observed;
    if (steps[0].status === "PASS") {
        for (const path of ["assets-input.json", "evidence/fetch.json", "evidence/SHASUMS256.txt"])
            await copyMetadata(join(acquired, path), join(meta, "acquisition", path));
        observed = await run(
            [
                "--import",
                "tsx",
                "scripts/observe-macos-runtime-assets.mjs",
                "--assets",
                join(acquired, "assets-input.json"),
                "--input-root",
                acquired,
                "--output-parent",
                join(root, "observation"),
                "--candidate",
                "observed",
            ],
            "observation/result.json",
            "observation/prepare.log",
        );
        const directory = join(root, "observation/observed");
        steps.push(summary("OBSERVE", observed, "MAC_RUNTIME_ASSETS_OBSERVATION_RESULT", directory));
        if (steps[1].status === "PASS") {
            for (const path of [
                "observation.json",
                "members/node.json",
                "members/chrome.json",
                "evidence/zip-modes.json",
            ])
                await copyMetadata(join(directory, path), join(meta, "observation", path));
        }
    } else steps.push({ step: "OBSERVE", status: "NOT_RUN", code: null, cleanup: null, actualBytes: null });
    await json(join(meta, "ci-process/observe-executions.json"), [acquire.journal, observed?.journal ?? null]);
    await json(join(meta, "steps.json"), steps);
    assert.equal(steps[1].status, "PASS", "asset observation failed");
}
async function bootstrap() {
    if (env.OBSERVE_OUTCOME !== "success") {
        await json(join(meta, "bootstrap/execution.json"), paused("BOOTSTRAP", "OBSERVER_FAILED"));
        return;
    }
    await bind("bootstrap");
    const refs = [];
    for (const name of ["runtime-node-bootstrap.ts", "prepare-macos-node-bootstrap.mjs"]) {
        const path = "apps/runtime/scripts/" + name;
        refs.push(ref(path, await committed(path)));
    }
    await json(join(meta, "bootstrap/source-binding.json"), {
        kind: "NODE_BOOTSTRAP_CI_SOURCE",
        ...identity,
        producer2Refs: refs,
    });
    const space = await statfs(root, { bigint: true });
    await json(join(meta, "bootstrap/launch-space.json"), {
        availableBytes: String(space.bavail * space.bsize),
        blockSize: String(space.bsize),
        policy: "ACTUAL_REMAINING_TRANSACTION_PLAN",
    });
    const acquired = join(root, "acquisition/acquired");
    const result = await run(
        [
            "--import",
            "tsx",
            "scripts/prepare-macos-node-bootstrap.mjs",
            "--assets",
            join(acquired, "assets-input.json"),
            "--input-root",
            acquired,
            "--output-parent",
            join(root, "bootstrap"),
            "--candidate",
            "prepared",
        ],
        "bootstrap/result.stdout.json",
        "bootstrap/prepare.log",
    );
    const directory = join(root, "bootstrap/prepared"),
        step = summary("BOOTSTRAP", result, "NODE_NPM_SOURCE_TREE_RESULT", directory);
    await json(join(meta, "bootstrap/execution.json"), {
        ...result.journal,
        step: "BOOTSTRAP",
        status: step.status,
        reason: null,
        code: step.code,
        phase: step.phase ?? null,
        cleanup: step.cleanup,
    });
    if (step.status === "PASS") {
        for (const path of [
            "node-bootstrap.json",
            "members/node.json",
            "evidence/producer/runtime-node-bootstrap.ts",
            "evidence/producer/prepare-macos-node-bootstrap.mjs",
        ])
            await copyMetadata(join(directory, path), join(meta, "bootstrap", path));
    }
    assert.equal(step.status, "PASS", "bootstrap execution failed");
}
const name = process.argv[2];
assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), identity.commit);
assert.equal(process.cwd(), join(env.GITHUB_WORKSPACE, "apps/runtime"));
assert.match(identity.commit, /^[a-f0-9]{40}$/);
assert.match(identity.runId, /^[0-9]+$/);
assert.ok(Number.isSafeInteger(identity.runAttempt) && identity.runAttempt >= 1);
assert.ok(["unit", "observe", "bootstrap"].includes(name));
await { unit, observe, bootstrap }[name]();
