import { constants } from "node:fs";
import { appendFile, lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

const env = process.env;
const root = env.ASSET_ROOT,
    metadata = join(root, "metadata"),
    upload = join(root, "upload");
const MiB = 1024 ** 2;
const outcomes = {
    unit: { outcome: env.UNIT_OUTCOME, conclusion: env.UNIT_CONCLUSION },
    bootstrap: { outcome: env.BOOTSTRAP_OUTCOME, conclusion: env.BOOTSTRAP_CONCLUSION },
};
const identity = {
    commit: env.GITHUB_SHA,
    runId: env.GITHUB_RUN_ID,
    runAttempt: Number(env.GITHUB_RUN_ATTEMPT),
    arch: env.EXPECTED_ARCH,
};
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const ref = (path, bytes) => ({ path, sizeBytes: bytes.length, sha256: hash(bytes) });
const buffer = (value) => Buffer.from(JSON.stringify(value));
const absent = async (path) => {
    try {
        await lstat(path);
        return false;
    } catch (error) {
        if (error.code === "ENOENT") return true;
        throw error;
    }
};
function reject(code = "ARTIFACT_IO", reason = null) {
    throw Object.assign(new Error(code), { collectionCode: code, reason });
}
function evidence(ok) {
    if (!ok) reject("ARTIFACT_IO", "MISSING_EXECUTION_EVIDENCE");
}
function same(a, b) {
    return ["dev", "ino", "size", "mode", "ctimeNs", "mtimeNs", "nlink"].every((key) => a[key] === b[key]);
}
let uncertain = false;
async function withFile(path, flags, action) {
    const handle = await open(path, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    let result, failure;
    try {
        result = await action(handle);
    } catch (error) {
        failure = error;
    }
    try {
        await handle.close();
    } catch (error) {
        uncertain = true;
        failure ??= error;
    }
    if (failure) throw failure;
    return result;
}
async function copyBytes(path, info, length) {
    return withFile(path, constants.O_RDONLY, async (handle) => {
        if (!same(info, await handle.stat({ bigint: true }))) reject("ARTIFACT_BOUNDARY");
        const bytes = Buffer.alloc(length);
        let offset = 0;
        while (offset < length) {
            const { bytesRead } = await handle.read(bytes, offset, length - offset, offset);
            if (!bytesRead) reject();
            offset += bytesRead;
        }
        if (!same(info, await handle.stat({ bigint: true }))) reject("ARTIFACT_BOUNDARY");
        return bytes;
    });
}
async function put(path, bytes) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await withFile(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, async (handle) => {
        let offset = 0;
        while (offset < bytes.length) {
            const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset);
            if (!bytesWritten) reject();
            offset += bytesWritten;
        }
    });
}
async function inventory() {
    const paths = new Map(),
        files = new Map();
    const totals = { logs: 0, metadata: 0 };
    async function visit(path, key, depth) {
        if (depth > 12 || paths.size >= 1024) reject("ARTIFACT_LIMIT");
        const stat = await lstat(path, { bigint: true });
        paths.set(path, stat);
        if (stat.uid !== BigInt(process.getuid()) || stat.mode & 0o022n) reject("ARTIFACT_BOUNDARY");
        if (stat.isDirectory()) {
            for (const name of (await readdir(path)).sort()) {
                if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,120}$/.test(name)) reject("ARTIFACT_BOUNDARY");
                await visit(join(path, name), key ? key + "/" + name : name, depth + 1);
            }
        } else {
            if (!key || !stat.isFile() || stat.nlink !== 1n || !/\.(?:log|json|txt|ts|mjs)$/.test(key))
                reject("ARTIFACT_BOUNDARY");
            if (["manifest.json", "failure.json", "ci-step-outcomes.json"].includes(key)) reject("ARTIFACT_BOUNDARY");
            if (stat.size > BigInt(4 * MiB)) reject("ARTIFACT_LIMIT");
            const group = key.endsWith(".log") ? "logs" : "metadata";
            totals[group] += Number(stat.size);
            if (totals.logs > 8 * MiB || totals.metadata > 16 * MiB) reject("ARTIFACT_LIMIT");
            files.set(key, stat);
        }
    }
    await visit(metadata, "", 0);
    return { paths, files };
}
function notRun(step, reason) {
    return {
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
    };
}
const runtimeCwd = join(env.GITHUB_WORKSPACE, "apps/runtime");
const cliArgs = {
    unit: ["--test", "tests/runtime-assets-ci-process.test.mjs"],
    acquire: [
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
    observe: [
        "--import",
        "tsx",
        "scripts/observe-macos-runtime-assets.mjs",
        "--assets",
        join(root, "acquisition/acquired/assets-input.json"),
        "--input-root",
        join(root, "acquisition/acquired"),
        "--output-parent",
        join(root, "observation"),
        "--candidate",
        "observed",
    ],
    bootstrap: [
        "--import",
        "tsx",
        "scripts/prepare-macos-node-bootstrap.mjs",
        "--assets",
        join(root, "acquisition/acquired/assets-input.json"),
        "--input-root",
        join(root, "acquisition/acquired"),
        "--output-parent",
        join(root, "bootstrap"),
        "--candidate",
        "prepared",
    ],
};
function completed(journal, command, pass) {
    evidence(
        journal &&
            journal.admitted === true &&
            journal.closeConfirmed === true &&
            journal.truncated === false &&
            journal.timedOut === false &&
            journal.error === null &&
            journal.signal === null &&
            Number.isSafeInteger(journal.elapsedMs) &&
            journal.elapsedMs >= 0 &&
            Number.isSafeInteger(journal.exit) &&
            journal.exit >= 0 &&
            journal.exit <= 255 &&
            (journal.exit === 0) === pass &&
            journal.cwd === runtimeCwd &&
            isDeepStrictEqual(journal.argv, [process.execPath, ...cliArgs[command]]),
    );
}
async function validate(stored, generated) {
    const json = (path) => {
        try {
            return JSON.parse(stored.get(path).toString("utf8"));
        } catch {
            evidence(false);
        }
    };
    function expectJournal(path, step, command, pass) {
        const journal = json(path);
        evidence(journal.step === step && journal.status === (pass ? "PASS" : "FAIL") && journal.reason === null);
        completed(journal, command, pass);
        return journal;
    }
    async function sourceRef(item, expectedPath) {
        evidence(item?.path === expectedPath && !expectedPath.split("/").includes(".."));
        const hostPath = resolve("../..", expectedPath);
        const hostStat = await lstat(hostPath, { bigint: true });
        evidence(hostStat.isFile() && hostStat.nlink === 1n && hostStat.size <= BigInt(4 * MiB));
        const bytes = await copyBytes(hostPath, hostStat, Number(hostStat.size));
        evidence(isDeepStrictEqual(item, ref(expectedPath, bytes)));
        return bytes;
    }
    const helperPaths = [
        "apps/runtime/scripts/runtime-assets-ci-process.mjs",
        "apps/runtime/tests/runtime-assets-ci-process.test.mjs",
    ];
    async function binding(stage) {
        const document = json("ci-process/binding-" + stage + ".json");
        evidence(
            document.kind === "ASSET_CI_PROCESS_SOURCE" &&
                Object.entries(identity).every(([k, v]) => document[k] === v),
        );
        evidence(document.ciProcessRefs?.length === 2);
        for (const [index, path] of helperPaths.entries()) {
            const host = await sourceRef(document.ciProcessRefs[index], path);
            evidence(host.equals(stored.get("ci-process/" + (index ? "test" : "helper") + ".mjs")));
        }
    }
    const setup = [env.BIND_OUTCOME, env.NODE_SETUP_OUTCOME, env.DEPENDENCIES_OUTCOME];
    const firstFailure = setup.indexOf("failure");
    if (
        firstFailure >= 0 &&
        setup.every(
            (value, i) => value === (i < firstFailure ? "success" : i === firstFailure ? "failure" : "skipped"),
        ) &&
        env.ORCHESTRATION_OUTCOME === "skipped"
    ) {
        evidence(
            isDeepStrictEqual(outcomes, {
                unit: { outcome: "skipped", conclusion: "skipped" },
                bootstrap: { outcome: "success", conclusion: "success" },
            }),
        );
        evidence(!["steps.json", "unit.json", "bootstrap/execution.json"].some((path) => stored.has(path)));
        generated.set(
            "steps.json",
            buffer([
                { step: "SETUP", status: "FAIL", code: "PAYLOAD_IO", cleanup: "NOT_NEEDED", actualBytes: null },
                ...["ACQUIRE", "OBSERVE"].map((step) => ({
                    step,
                    status: "NOT_RUN",
                    code: null,
                    cleanup: null,
                    actualBytes: null,
                })),
            ]),
        );
        generated.set("unit.json", buffer(notRun("UNIT", "SETUP_FAILED")));
        generated.set("bootstrap/execution.json", buffer(notRun("BOOTSTRAP", "SETUP_FAILED")));
        return;
    }
    evidence(setup.every((value) => value === "success"));
    const steps = json("steps.json");
    evidence(Array.isArray(steps) && steps.length === 2 && steps[0].step === "ACQUIRE" && steps[1].step === "OBSERVE");
    evidence(outcomes.unit.outcome === "success" && outcomes.unit.conclusion === "success");
    const unit = expectJournal("unit.json", "UNIT", "unit", true);
    evidence(unit.code === null && unit.phase === null && unit.cleanup === null);
    evidence(stored.has("unit.stdout.log") && stored.has("unit.stderr.log"));
    await binding("unit");
    await binding("observe");
    const executions = json("ci-process/observe-executions.json");
    evidence(Array.isArray(executions) && executions.length === 2);
    const acquired = steps[0].status === "PASS";
    evidence(acquired || steps[0].status === "FAIL");
    completed(executions[0], "acquire", acquired);
    if (acquired) {
        evidence(["PASS", "FAIL"].includes(steps[1].status));
        completed(executions[1], "observe", steps[1].status === "PASS");
    } else evidence(executions[1] === null && steps[1].status === "NOT_RUN");
    for (const step of steps) {
        if (step.status === "PASS") evidence(step.code === null && step.cleanup === "CONFIRMED");
        if (step.status === "FAIL")
            evidence(
                /^PAYLOAD_[A-Z_]+$/.test(step.code) && ["CONFIRMED", "INCOMPLETE", "NOT_NEEDED"].includes(step.cleanup),
            );
        if (step.status === "NOT_RUN") evidence(step.code === null && step.cleanup === null);
    }
    if (steps[1].status !== "PASS") {
        evidence(
            env.ORCHESTRATION_OUTCOME === "failure" &&
                outcomes.bootstrap.outcome === "success" &&
                outcomes.bootstrap.conclusion === "success" &&
                isDeepStrictEqual(json("bootstrap/execution.json"), notRun("BOOTSTRAP", "OBSERVER_FAILED")),
        );
        return;
    }
    evidence(env.ORCHESTRATION_OUTCOME === "success");
    const facts = json("source.json");
    evidence(
        facts.schemaVersion === 1 &&
            facts.kind === "ASSET_OBSERVER_SOURCE" &&
            Object.entries(identity).every(([k, v]) => facts[k] === v) &&
            /^15\.[0-9]+(?:\.[0-9]+)?$/.test(facts.osVersion) &&
            facts.nodeVersion === "24.22.1" &&
            /^[0-9a-f]{64}$/.test(facts.nodeSha256),
    );
    const sourcePaths = [
        ...[
            "runtime-assets-observation.ts",
            "runtime-assets-acquisition.ts",
            "observe-macos-runtime-assets.mjs",
            "acquire-macos-runtime-assets.mjs",
            ...["archive", "tar", "zip", "transaction", "inputs", "tree", "receipts", "graph"].map(
                (part) => "runtime-payload-" + part + ".ts",
            ),
        ].map((name) => "apps/runtime/scripts/" + name),
        "apps/runtime/src/distribution-manifest-v2.ts",
        "apps/runtime/src/node-version.ts",
        "packages/contracts/src/index.ts",
        "packages/contracts/src/validators.ts",
        "packages/contracts/schemas/platform-v1.schema.json",
        "pnpm-lock.yaml",
        ".github/workflows/runtime-payload-macos.yml",
    ];
    evidence(Array.isArray(facts.files) && facts.files.length === sourcePaths.length);
    for (const path of sourcePaths)
        await sourceRef(
            facts.files.find((file) => file.path === path),
            path,
        );
    await binding("bootstrap");
    const producers = json("bootstrap/source-binding.json");
    evidence(
        producers.kind === "NODE_BOOTSTRAP_CI_SOURCE" &&
            Object.entries(identity).every(([k, v]) => producers[k] === v) &&
            producers.producer2Refs?.length === 2,
    );
    for (const [i, name] of ["runtime-node-bootstrap.ts", "prepare-macos-node-bootstrap.mjs"].entries())
        await sourceRef(producers.producer2Refs[i], "apps/runtime/scripts/" + name);
    const space = json("bootstrap/launch-space.json");
    evidence(
        space.policy === "ACTUAL_REMAINING_TRANSACTION_PLAN" &&
            /^\d+$/.test(space.availableBytes) &&
            /^[1-9]\d*$/.test(space.blockSize),
    );
    const pass = outcomes.bootstrap.outcome === "success";
    evidence((pass || outcomes.bootstrap.outcome === "failure") && outcomes.bootstrap.conclusion === "success");
    const journal = expectJournal("bootstrap/execution.json", "BOOTSTRAP", "bootstrap", pass);
    evidence(stored.has("bootstrap/result.stdout.json") && stored.has("bootstrap/prepare.log"));
    if (pass) {
        // 引导成功时逐项复核收据引用的观察结果、来源和成员文件，确保上传的证据对应同一次运行及同一份输入。
        const retainedRef = (item, prefix, path) => {
            const bytes = stored.get(prefix + "/" + path);
            evidence(bytes && isDeepStrictEqual(item, ref(path, bytes)));
        };
        const acquired = json("acquisition/result.json"),
            input = json("acquisition/assets-input.json");
        const observed = json("observation/result.json"),
            observation = json("observation/observation.json");
        const source = { commit: identity.commit, evidence: ref("evidence/source.json", stored.get("source.json")) };
        evidence(
            acquired.kind === "MAC_RUNTIME_ASSETS_ACQUISITION_RESULT" &&
                acquired.committed === true &&
                acquired.cleanup === "CONFIRMED" &&
                acquired.status === "UNREVIEWED_SOURCE" &&
                acquired.directory === join(root, "acquisition/acquired"),
        );
        retainedRef(acquired.input, "acquisition", "assets-input.json");
        evidence(
            input.kind === "MAC_RUNTIME_ASSETS_OBSERVATION_INPUT" &&
                input.arch === identity.arch &&
                isDeepStrictEqual(input.source, source),
        );
        retainedRef(input.fetchEvidence, "acquisition", "evidence/fetch.json");
        const fetch = json("acquisition/evidence/fetch.json");
        evidence(
            fetch.sourceStatus === "UNREVIEWED_SOURCE" &&
                fetch.publisherSignature === "NOT_VERIFIED" &&
                isDeepStrictEqual(fetch.node.body, input.node) &&
                isDeepStrictEqual(fetch.chrome.body, input.chrome),
        );
        retainedRef(fetch.nodeChecksumText.body, "acquisition", "evidence/SHASUMS256.txt");
        evidence(
            observed.kind === "MAC_RUNTIME_ASSETS_OBSERVATION_RESULT" &&
                observed.committed === true &&
                observed.cleanup === "CONFIRMED" &&
                observed.directory === join(root, "observation/observed") &&
                observed.status === "UNREVIEWED_SOURCE_REQUIRES_LAYOUT_REVIEW",
        );
        retainedRef(observed.observation, "observation", "observation.json");
        evidence(
            observation.arch === identity.arch &&
                observation.sourceStatus === "UNREVIEWED_SOURCE" &&
                observation.publisherSignature === "NOT_VERIFIED" &&
                observation.kind === "MAC_RUNTIME_ASSETS_OBSERVATION" &&
                observation.inputSha256 === acquired.input.sha256 &&
                isDeepStrictEqual(observation.source, source) &&
                observation.chromeLayout.status === "REQUIRES_LAYOUT_REVIEW" &&
                observation.archives.length === 2,
        );
        for (const [i, kind] of ["node", "chrome"].entries()) {
            const archive = observation.archives[i],
                expected = input[kind];
            evidence(
                archive.kind === kind &&
                    archive.snapshot.sha256 === expected.sha256 &&
                    archive.snapshot.sizeBytes === expected.sizeBytes,
            );
            retainedRef(archive.members, "observation", "members/" + kind + ".json");
        }
        retainedRef(observation.archives[1].modeEvidence, "observation", "evidence/zip-modes.json");
        const result = json("bootstrap/result.stdout.json"),
            receipt = json("bootstrap/node-bootstrap.json");
        evidence(
            journal.cleanup === "CONFIRMED" &&
                result.kind === "NODE_NPM_SOURCE_TREE_RESULT" &&
                result.committed === true &&
                result.cleanup === "CONFIRMED" &&
                result.directory === join(root, "bootstrap/prepared") &&
                isDeepStrictEqual(
                    result.receipt,
                    ref("node-bootstrap.json", stored.get("bootstrap/node-bootstrap.json")),
                ) &&
                receipt.kind === "NODE_NPM_SOURCE_TREE" &&
                receipt.arch === identity.arch &&
                receipt.source.commit === identity.commit &&
                receipt.sourceStatus === "UNREVIEWED_SOURCE" &&
                isDeepStrictEqual(receipt.source, source) &&
                receipt.inputSha256 === acquired.input.sha256 &&
                receipt.archive.sha256 === input.node.sha256 &&
                receipt.archive.sizeBytes === input.node.sizeBytes,
        );
        retainedRef(receipt.members, "bootstrap", "members/node.json");
        evidence(receipt.producerFiles.length === producers.producer2Refs.length);
        for (const [i, name] of ["runtime-node-bootstrap.ts", "prepare-macos-node-bootstrap.mjs"].entries()) {
            retainedRef(receipt.producerFiles[i], "bootstrap", "evidence/producer/" + name);
            evidence(receipt.producerFiles[i].sha256 === producers.producer2Refs[i].sha256);
        }
    } else {
        const diagnostics = [
            ...stored
                .get("bootstrap/prepare.log")
                .toString("utf8")
                .matchAll(/^(PAYLOAD_[A-Z_]+) phase=([A-Z_]+) cleanup=(NOT_NEEDED|CONFIRMED|INCOMPLETE)$/gm),
        ];
        evidence(diagnostics.length === 1);
        const [match] = diagnostics;
        evidence(match && journal.code === match[1] && journal.phase === match[2] && journal.cleanup === match[3]);
    }
}
async function collect(draft) {
    const { paths, files } = await inventory();
    const stored = new Map(),
        truncations = [];
    for (const [path, stat] of files) {
        const truncate = path === "pnpm-install.log" && stat.size > 32768n;
        let bytes = await copyBytes(join(metadata, path), stat, truncate ? 32700 : Number(stat.size));
        if (truncate) {
            bytes = Buffer.concat([bytes, Buffer.from("\nLOG_TRUNCATED: hash binds retained prefix only\n")]);
            truncations.push({ path, originalSizeBytes: Number(stat.size), retainedPrefixBytes: 32700 });
        }
        await put(join(draft, path), bytes);
        stored.set(path, bytes);
    }
    const generated = new Map([["ci-step-outcomes.json", buffer(outcomes)]]);
    await validate(stored, generated);
    // 从待上传目录重新打开每个文件并核对实际保留的字节，源目录身份复核结束后才能写清单并发布。
    for (const [path, bytes] of stored) {
        const staged = join(draft, path),
            stat = await lstat(staged, { bigint: true });
        if (stat.size !== BigInt(bytes.length) || !(await copyBytes(staged, stat, bytes.length)).equals(bytes))
            reject();
    }
    for (const [path, stat] of paths) if (!same(stat, await lstat(path, { bigint: true }))) reject("ARTIFACT_BOUNDARY");
    for (const [path, bytes] of generated) {
        evidence(!stored.has(path));
        await put(join(draft, path), bytes);
        stored.set(path, bytes);
    }
    return publish(draft, "FULL", stored, truncations);
}
async function publish(draft, collection, stored, truncations) {
    const files = [...stored.keys()].sort().map((path) => ref(path, stored.get(path)));
    const manifest = buffer({ source: env.GITHUB_SHA, arch: env.EXPECTED_ARCH, collection, files, truncations });
    if (files.reduce((n, file) => n + (file.path.endsWith(".log") ? 0 : file.sizeBytes), manifest.length) > 16 * MiB)
        reject("ARTIFACT_LIMIT");
    await put(join(draft, "manifest.json"), manifest);
    if (!(await absent(upload))) reject("ARTIFACT_BOUNDARY");
    await rename(draft, upload);
    await appendFile(
        env.GITHUB_OUTPUT,
        "upload_root=" +
            upload +
            "\ncollection=" +
            collection +
            "\nmanifest_sha256=" +
            hash(manifest) +
            "\nready=true\n",
    );
}
async function main() {
    if (
        /[\r\n]/.test(root) ||
        root !== (await realpath(root)) ||
        !(await absent(upload)) ||
        !/^[a-f0-9]{40}$/.test(identity.commit) ||
        !["arm64", "x64"].includes(identity.arch) ||
        !/^\d+$/.test(identity.runId) ||
        !Number.isSafeInteger(identity.runAttempt) ||
        identity.runAttempt < 1
    )
        reject("ARTIFACT_BOUNDARY");
    const rootStat = await lstat(root);
    if (!rootStat.isDirectory() || rootStat.uid !== process.getuid() || rootStat.mode & 0o077)
        reject("ARTIFACT_BOUNDARY");
    const draft = await mkdtemp(join(root, ".upload-build-"));
    try {
        await collect(draft);
    } catch (error) {
        if (!(await absent(upload))) throw error;
        if (!uncertain) await rm(draft, { recursive: true });
        const failure = buffer({
            status: "FAIL",
            code: error.collectionCode ?? "ARTIFACT_IO",
            reason: error.reason ?? null,
            cleanup: uncertain ? "INCOMPLETE" : "CONFIRMED",
            steps: [
                { step: "COLLECT", status: "FAIL" },
                { step: "PUBLISH_FULL", status: "NOT_RUN" },
            ],
        });
        const fallback = await mkdtemp(join(root, ".upload-build-"));
        await put(join(fallback, "failure.json"), failure);
        await publish(fallback, "FAILURE", new Map([["failure.json", failure]]), []);
        process.exitCode = 1;
    }
}
try {
    await main();
} catch {
    process.stderr.write("ARTIFACT_COLLECTION_UNCONFIRMED ready=false cleanup=INCOMPLETE\n");
    process.exitCode = 1;
}
