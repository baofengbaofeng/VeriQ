import { trackZipClosure, closeUntransferredZipFd } from "./runtime-payload-zip.ts";
import { createHash, randomUUID } from "node:crypto";
import { constants, open as openFd, fstat, createReadStream } from "node:fs";
import { join, dirname } from "node:path";
import { finished } from "node:stream/promises";
import { fromFdPromise, type Entry, type ZipFile } from "yauzl";
import { canonicalBytes } from "@veriq/contracts";
import {
    RuntimePayloadError,
    admitRuntimePayloadInputs,
    verifyRuntimePayloadInputs,
    type ExpectedPayloadInputs,
    type Cleanup,
    type Ref,
    type FileFact,
    type InputInspection,
} from "./runtime-payload-inputs.ts";
import {
    intakeRuntimeArchives,
    type StageOptions,
    type IntakeResult,
    type ArchiveMember,
} from "./runtime-payload-archive.ts";
import { ArchiveTransaction, controlledIoFailure } from "./runtime-payload-transaction.ts";
import { freeze, limits, paths, relative, sha } from "./runtime-payload-tree.ts";
import {
    projectNpm,
    copyPayloadFile,
    npmLinkSource,
    safeMode,
    once,
} from "./runtime-payload-npm.ts";
import { bindGeneratorSources } from "./runtime-payload-generation.ts";
import { renderBinShim, BIN_SHIM_TEMPLATE } from "./runtime-payload-bins.ts";
import {
    manifestBytes,
    type Origin,
    type OutputFact,
    type PayloadReceipt,
} from "./runtime-payload-manifest.ts";
import {
    verifyMacRuntimeManifestV2,
    MacRuntimeManifestError,
    type MacRuntimeStaticInventory,
} from "../src/distribution-manifest-v2.ts";

/**
 * 候选结果只包含最终路径实际完成的 D3a 库存和外部 receipt 摘要，所有嵌套事实返回前深冻结；已提交但锁或工作目录收尾不确
 * 认仍明确 INCOMPLETE，不能改写 committed 或删除候选伪称已经回滚。
 */
export type PayloadResult = Readonly<{
    kind: "MAC_RUNTIME_PAYLOAD_CANDIDATE";
    candidateDirectory: string;
    runtimeDirectory: string;
    receiptSha256: string;
    inventory: MacRuntimeStaticInventory;
    committed: true;
    cleanup: Cleanup;
}>;

type Copy = { fact: OutputFact; root: string; source: Ref };
const rootPackage = Buffer.from('{"private":true,"type":"module"}\n');

/**
 * 所有实际复制到包外 input-evidence 的 Ref 必须共享固定六十四 MiB 总额，原配方、独立 expected 和本次 intake 收据也逐份
 * 计入；该检查只核数值预算而不冒充来源或文件真实性验证，磁盘剩余写入
 * 计划另行处理。
 */
export function assertPayloadEvidenceBudget(receipts: readonly Ref[]): void {
    let total = 0;
    for (const receipt of receipts) {
        if (!Number.isSafeInteger(receipt.sizeBytes) || receipt.sizeBytes < 0)
            throw new RuntimePayloadError("PAYLOAD_LIMIT");
        total += receipt.sizeBytes;
        if (!Number.isSafeInteger(total) || total > limits.evidence)
            throw new RuntimePayloadError("PAYLOAD_LIMIT");
    }
}

/**
 * 完整 stage 首次等待前私有复制配方与独立 policy 并快照全部选项，之后真实重验五树和本次归档 intake；最终 Runtime 只从已
 * 核源独立复制和固定模板生成，未知子事务状态会保留父目录而不会被外层清理覆盖。
 */
export async function stageMacRuntimePayload(
    bytes: Uint8Array,
    expected: ExpectedPayloadInputs,
    options: StageOptions,
): Promise<Readonly<PayloadResult>> {
    const admitted = admitRuntimePayloadInputs(bytes, expected);
    const inputRoot = options?.inputRoot,
        outputParent = options?.outputParent,
        candidateName = options?.candidateName,
        signal = options?.signal;
    if (
        typeof inputRoot !== "string" ||
        typeof outputParent !== "string" ||
        typeof candidateName !== "string" ||
        (signal !== undefined && !(signal instanceof AbortSignal))
    )
        throw new RuntimePayloadError("PAYLOAD_INPUT_INVALID");
    const work = new ArchiveTransaction(
        inputRoot,
        outputParent,
        `s-work-${randomUUID()}`,
        signal,
        "work",
    );
    const final = new ArchiveTransaction(inputRoot, outputParent, candidateName, signal, "runtime");
    let verified = false,
        workCleanup: Cleanup = "NOT_NEEDED";
    try {
        const report = await verifyRuntimePayloadInputs(admitted.bytes, admitted.expected, {
            inputRoot,
            ...(signal ? { signal } : {}),
        });
        verified = true;
        const generation = await bindGeneratorSources(report, inputRoot, signal);
        await final.initialize();
        final.phase = "COPY";
        await final.observeSources(report);
        await work.initialize();
        work.phase = "INTAKE";
        // 子 intake 使用工作目录内固定短候选名，必须等待实际返回或异常后才能决定是否清理父目录；任何关闭或提交不确定立
        // 即粘住 work 归属，独立 final 的成功清理不能覆盖这份未知事实。
        let intake: IntakeResult;
        try {
            intake = await intakeRuntimeArchives(admitted.bytes, admitted.expected, {
                inputRoot,
                outputParent: join(work.scratch, "intakes"),
                candidateName: "intake",
                ...(signal ? { signal } : {}),
            });
            if (intake.cleanup !== "CONFIRMED") {
                work.noteCloseFailure();
                throw new RuntimePayloadError("PAYLOAD_IO", null, "INCOMPLETE", {
                    phase: "INTAKE",
                    candidateDirectory: final.directory,
                });
            }
        } catch (error) {
            if (
                !(error instanceof RuntimePayloadError) ||
                error.code === "PAYLOAD_COMMIT_UNCONFIRMED" ||
                error.cleanup === "INCOMPLETE"
            )
                work.noteCloseFailure();
            throw error;
        }
        await explicitZipModes(intake, work);
        work.phase = "COPY";
        const npm = await projectNpm(report, intake, work);
        // 目标所有权先在内存中登记完整逻辑成员，文件与大小写冲突即使正文摘要相同也拒绝，只有明确普通目录可合并；真实写
        // 入尚未开始，因此空间计划与后续清单来自同一最终输出集合。
        const files: OutputFact[] = [],
            directories = new Set<string>(),
            copies: Copy[] = [],
            generated: { fact: OutputFact; bytes: Uint8Array }[] = [];
        const occupied = new Map<string, { path: string; kind: "file" | "directory" | "link" }>();
        const register = (path: string, kind: "file" | "directory" | "link") => {
            relative(path);
            const prior = occupied.get(path.toLowerCase());
            if (
                prior &&
                (prior.path !== path || prior.kind !== "directory" || kind !== "directory")
            )
                final.fail("PAYLOAD_COLLISION");
            occupied.set(path.toLowerCase(), { path, kind });
            if (kind === "directory") directories.add(path);
        };
        const parents = (path: string) => {
            const list: string[] = [];
            for (let current = dirname(path); current !== "."; current = dirname(current))
                list.push(current);
            for (const parent of list.reverse()) register(parent, "directory");
        };
        const addCopy = (
            root: string,
            source: Ref,
            path: string,
            mode: FileFact["mode"],
            origins: readonly Origin[],
        ) => {
            parents(path);
            register(path, "file");
            const fact: OutputFact = {
                path,
                sizeBytes: source.sizeBytes,
                sha256: source.sha256,
                mode,
                origins,
            };
            copies.push({ fact, root, source });
            files.push(fact);
        };
        // 生成来源只能从本次实际宿主源码与输入副本三方匹配后的固定清单选择，不能用任意 producer 别名或伪造空路径代替；
        // 每个固定生成文件都必须取得真实 Ref 才进入候选输出集合。
        const code = (path: string, transform: Origin["transform"]): Origin => {
            const ref = generation.files.find(
                (file) => file.path === `apps/runtime/scripts/${path}`,
            );
            if (!ref) throw new RuntimePayloadError("PAYLOAD_RECEIPT_MISMATCH");
            return { input: "generated", path: ref.path, sha256: ref.sha256, transform };
        };
        const addGenerated = (
            path: string,
            content: Uint8Array,
            mode: FileFact["mode"],
            origins: readonly Origin[],
        ) => {
            parents(path);
            register(path, "file");
            const fact: OutputFact = {
                path,
                sizeBytes: content.length,
                sha256: sha(content),
                mode,
                origins,
            };
            files.push(fact);
            generated.push({ fact, bytes: content });
        };
        const nodeMembers = intake.receipt.archives.find(
            (archive) => archive.kind === "node",
        )!.members;
        const node = nodeMembers.find((member) => member.path === report.nodeReceipt.nodeMember);
        if (node?.kind !== "file" || !(node.mode & 0o111))
            throw new RuntimePayloadError("PAYLOAD_ARCHIVE_UNSUPPORTED");
        for (const [role, name] of [
            ["agent", "veriq_agent"],
            ["cli", "veriq_cli"],
            ["runner", "veriq_runner"],
        ])
            addCopy(
                intake.directory,
                { ...node, path: `trees/node/${node.path}` },
                `roles/${role}/${name}`,
                safeMode(node.mode),
                [{ input: "node", path: node.path, sha256: node.sha256, transform: "role-copy" }],
            );
        const license = nodeMembers.find(
            (member) => member.path === `${report.recipe.node.topDirectory}/LICENSE`,
        );
        if (license?.kind !== "file") throw new RuntimePayloadError("PAYLOAD_ARCHIVE_UNSUPPORTED");
        addCopy(
            intake.directory,
            { ...license, path: `trees/node/${license.path}` },
            "licenses/node/LICENSE",
            safeMode(license.mode),
            [{ input: "node", path: license.path, sha256: license.sha256, transform: "copy" }],
        );
        for (const directory of npm.inventory.directories) {
            parents(directory);
            register(directory, "directory");
        }
        for (const file of npm.files) {
            if (report.nodeReceipt.npmGraph.bins.some((bin) => bin.sourceAlias === file.fact.path))
                continue;
            addCopy(
                work.scratch,
                { ...file.fact, path: `views/${file.fact.path}` },
                file.fact.path,
                file.fact.mode,
                file.origins,
            );
        }
        for (const kind of ["entries", "execution", "dependencies", "native", "engine"] as const) {
            const tree = report.trees[kind],
                bound = report.recipe[kind];
            const prefix =
                kind === "entries"
                    ? "entry/"
                    : kind === "execution"
                      ? "execution/"
                      : kind === "native"
                        ? "native/"
                        : kind === "engine"
                          ? `engines/${report.recipe.target.engineVersion}/`
                          : "";
            for (const directory of tree.inventory.directories) {
                const path = prefix + directory;
                parents(path);
                register(path, "directory");
            }
            for (const file of tree.inventory.files) {
                if (
                    kind === "dependencies" &&
                    report.trees.dependencies.receipt.graph.bins.some(
                        (bin) => bin.sourceAlias === file.path,
                    )
                )
                    continue;
                addCopy(
                    inputRoot,
                    { ...file, path: `${bound.root}/${file.path}` },
                    prefix + file.path,
                    file.mode,
                    [{ input: kind, path: file.path, sha256: file.sha256, transform: "copy" }],
                );
            }
        }
        for (const member of intake.receipt.archives.find((archive) => archive.kind === "chrome")!
            .members) {
            const path = `browser/${member.path}`;
            if (member.kind === "directory") {
                parents(path);
                register(path, "directory");
            } else if (member.kind === "link") {
                parents(path);
                register(path, "link");
            } else
                addCopy(
                    intake.directory,
                    { ...member, path: `trees/chrome/${member.path}` },
                    path,
                    safeMode(member.mode),
                    [
                        {
                            input: "chrome",
                            path: member.path,
                            sha256: member.sha256,
                            transform:
                                safeMode(member.mode) === member.mode ? "copy" : "mode-normalize",
                        },
                    ],
                );
        }
        addGenerated("package.json", rootPackage, 0o644, [
            code("runtime-payload-stage.ts", "runtime-package-v1"),
        ]);
        // 原 alias 先被真实内容核验并从普通复制集合精确跳过，原 target 永远保留原包位置；现在才生成独立普通 shim，并把
        // package.json、目标正文、原始 alias 链及固定模板代码来源一起记入收据。
        for (const [graph, input, inventory] of [
            [report.nodeReceipt.npmGraph, "node", npm.inventory],
            [
                report.trees.dependencies.receipt.graph,
                "dependencies",
                report.trees.dependencies.inventory,
            ],
        ] as const)
            for (const bin of graph.bins) {
                const owner = graph.instances.find((instance) => instance.id === bin.owner)!;
                const pkg = inventory.files.find(
                    (file) => file.path === `${owner.root}/package.json`,
                )!;
                const target = inventory.files.find((file) => file.path === bin.targetPath)!;
                const origins: Origin[] = [
                    {
                        input,
                        path:
                            input === "node"
                                ? `${report.nodeReceipt.npmRoot}/${pkg.path.slice(4)}`
                                : pkg.path,
                        sha256: pkg.sha256,
                        transform: "bin-shim-v1",
                    },
                    {
                        input,
                        path:
                            input === "node"
                                ? `${report.nodeReceipt.npmRoot}/${target.path.slice(4)}`
                                : target.path,
                        sha256: target.sha256,
                        transform: "bin-shim-v1",
                    },
                    code("runtime-payload-bins.ts", "bin-shim-v1"),
                ];
                if (bin.sourceAlias && input === "node")
                    origins.push(
                        ...npmLinkSource(
                            `${report.nodeReceipt.npmRoot}/${bin.sourceAlias.slice(4)}`,
                            nodeMembers,
                            report.nodeReceipt.npmRoot,
                        ).origins,
                    );
                else if (bin.sourceAlias) {
                    const link = inventory.links.find((value) => value.path === bin.sourceAlias),
                        file = inventory.files.find((value) => value.path === bin.sourceAlias);
                    if (!link && !file) final.fail("PAYLOAD_BIN_UNSUPPORTED");
                    origins.push({
                        input,
                        path: bin.sourceAlias,
                        sha256: link ? sha(Buffer.from(link.target)) : file!.sha256,
                        transform: "bin-shim-v1",
                    });
                }
                addGenerated(bin.aliasPath, renderBinShim(bin), 0o755, origins);
            }
        verifyConsumers(report, files, final);
        paths(
            [
                ...directories,
                ...files.map((file) => file.path),
                ...report.chromeLayout.layout.allowedLinks.map((link) => link.path),
            ],
            [...directories],
        );
        const manifest = manifestBytes(
            report.recipe,
            report.chromeLayout.layout,
            files,
            [...directories],
            report.chromeLayout.layout.allowedLinks,
        );
        addGenerated("runtime-manifest.json", manifest, 0o644, [
            code("runtime-payload-manifest.ts", "manifest-v2"),
        ]);
        // 大源码和原压缩归档只保留外部身份，不复制进安装树；必需的小证据使用 refs 子目录保持原相对路径，原配方、独立
        // expected 与本次 intake 原回执另占固定名称，避免与输入证据的命名冲突。
        const sourceNames = new Set(report.sourceBinding.files.map((file) => file.path));
        const excluded = new Set([
            report.recipe.source.archive.path,
            report.recipe.node.file.path,
            report.recipe.chrome.file.path,
        ]);
        const evidence = report.checkedEvidence.filter(
            (ref) =>
                !excluded.has(ref.path) &&
                (!sourceNames.has(ref.path) || ref.path === report.recipe.source.pnpmLock.path),
        );
        const descriptors = [
            { path: "inputs.json", bytes: admitted.bytes },
            { path: "expected.json", bytes: canonicalBytes(admitted.expected) },
            { path: "archive-intake.json", bytes: canonicalBytes(intake.receipt) },
        ];
        const descriptorRefs = descriptors.map((descriptor) => ({
            path: `input-evidence/${descriptor.path}`,
            sizeBytes: descriptor.bytes.length,
            sha256: sha(descriptor.bytes),
        }));
        if (descriptorRefs[2]!.sha256 !== intake.receiptSha256)
            final.fail("PAYLOAD_SOURCE_CHANGED");
        const inputReceipts = [
            ...evidence.map((ref) => ({ ...ref, path: `input-evidence/refs/${ref.path}` })),
            ...descriptorRefs,
        ].sort((a, b) => (a.path < b.path ? -1 : 1));
        assertPayloadEvidenceBudget(inputReceipts);
        const receipt: PayloadReceipt = {
            schemaVersion: 1,
            kind: "MAC_RUNTIME_PAYLOAD_CANDIDATE",
            status: "DEVELOPMENT_UNSIGNED_STATIC",
            recipeSha256: admitted.recipeSha256,
            target: report.recipe.target,
            source: report.recipe.source,
            tools: report.recipe.tools,
            inputReceipts,
            chromeLayoutSha256: report.recipe.chromeLayout.sha256,
            runtimeManifestSha256: sha(manifest),
            files: files.sort((a, b) => (a.path < b.path ? -1 : 1)),
            links: report.chromeLayout.layout.allowedLinks,
            counts: {
                files: files.length - 1,
                directories: directories.size,
                links: report.chromeLayout.layout.allowedLinks.length,
                fileBytes: files
                    .filter((file) => file.path !== "runtime-manifest.json")
                    .reduce((sum, file) => sum + file.sizeBytes, 0),
            },
            templateSha256: sha(Buffer.from(BIN_SHIM_TEMPLATE)),
        };
        const receiptBytes = canonicalBytes(receipt);
        if (receiptBytes.length > limits.json) final.fail("PAYLOAD_LIMIT");
        const evidenceDirectories = new Set<string>();
        for (const ref of inputReceipts)
            for (
                let parent = dirname(ref.path);
                parent !== "input-evidence";
                parent = dirname(parent)
            )
                evidenceDirectories.add(parent);
        // 当前磁盘已实际容纳 work 内的快照、解压树和 npm 投影，此处只计算尚未写入的最终独立副本与完整证据；三角色逐份收
        // 费，不能按相同摘要去重，也不把已经占用的 work 字节再次加入 remaining。
        await final.plan(
            files.reduce((sum, file) => sum + file.sizeBytes, 0) +
                inputReceipts.reduce((sum, file) => sum + file.sizeBytes, 0) +
                receiptBytes.length,
            files.length +
                directories.size +
                inputReceipts.length +
                evidenceDirectories.size +
                report.chromeLayout.layout.allowedLinks.length +
                1,
        );
        for (const directory of [...directories].sort()) await final.mkdir(`runtime/${directory}`);
        for (const copy of copies)
            await copyPayloadFile(
                final,
                copy.root,
                copy.source,
                `runtime/${copy.fact.path}`,
                copy.fact.mode,
            );
        for (const file of generated)
            await final.write(
                `runtime/${file.fact.path}`,
                once(file.bytes),
                file.fact,
                file.fact.mode,
            );
        await final.createChromeLinks(report.chromeLayout.layout);
        final.phase = "VERIFY";
        const checked = await verifyMacRuntimeManifestV2(join(final.scratch, "runtime"), {
            arch: report.recipe.target.arch,
            layout: report.chromeLayout.layout,
        });
        if (checked.manifestSha256 !== receipt.runtimeManifestSha256)
            final.fail("PAYLOAD_STATIC_VERIFY_FAILED");
        for (const ref of evidence)
            await copyPayloadFile(final, inputRoot, ref, `input-evidence/refs/${ref.path}`);
        for (let index = 0; index < descriptors.length; index++)
            await final.write(
                descriptorRefs[index]!.path,
                once(descriptors[index]!.bytes),
                descriptorRefs[index],
            );
        const receiptFact = await final.write("payload-receipt.json", once(receiptBytes));
        // 临时 D3a 与包外回执写完后，先复核原输入和实际生成代码再进入发布边界；publishRuntime 内部必须在 rename 后真正
        // 再核最终 runtime，不能把此处库存对象的 root 改成最终路径冒充实测。
        await final.finishSources();
        await verifyRuntimePayloadInputs(admitted.bytes, admitted.expected, {
            inputRoot,
            ...(signal ? { signal } : {}),
        });
        await generation.finish();
        await final.finishSources();
        const published = await final.publishRuntime({
            arch: report.recipe.target.arch,
            layout: report.chromeLayout.layout,
            manifestSha256: receipt.runtimeManifestSha256,
        });
        workCleanup = await work.cleanup();
        return freeze({
            kind: "MAC_RUNTIME_PAYLOAD_CANDIDATE",
            candidateDirectory: final.directory,
            runtimeDirectory: join(final.directory, "runtime"),
            receiptSha256: receiptFact.sha256,
            inventory: published.inventory,
            committed: true,
            cleanup:
                published.cleanup === "INCOMPLETE" || workCleanup === "INCOMPLETE"
                    ? "INCOMPLETE"
                    : "CONFIRMED",
        });
    } catch (error) {
        // 两个事务独立关闭和清理，并用最保守的实际结果聚合失败状态；已提交或尚有 writer 的 artifact 由各自事务保留，原
        // 始磁盘分类和首错误不能被后续成功清理或次要关闭异常覆盖。
        const finalCleanup = await final.cleanup();
        workCleanup = await work.cleanup();
        const cleanup: Cleanup = [
            finalCleanup,
            workCleanup,
            error instanceof RuntimePayloadError ? error.cleanup : "NOT_NEEDED",
        ].includes("INCOMPLETE")
            ? "INCOMPLETE"
            : finalCleanup === "NOT_NEEDED" && workCleanup === "NOT_NEEDED"
              ? "NOT_NEEDED"
              : "CONFIRMED";
        if (!verified && error instanceof RuntimePayloadError) throw error;
        if (error instanceof RuntimePayloadError)
            throw new RuntimePayloadError(error.code, error.causeCode, cleanup, {
                phase: error.phase === "INPUTS" ? final.phase : error.phase,
                candidateDirectory: final.directory,
            });
        if (error instanceof MacRuntimeManifestError)
            throw new RuntimePayloadError("PAYLOAD_STATIC_VERIFY_FAILED", error.code, cleanup, {
                phase: final.phase,
                candidateDirectory: final.directory,
            });
        const known = controlledIoFailure(error);
        throw new RuntimePayloadError(
            known?.code ?? "PAYLOAD_IO",
            known?.causeCode ?? null,
            cleanup,
            { phase: final.phase, candidateDirectory: final.directory },
        );
    }
}

/**
 * 所有 resolution consumer 与目标都必须是本次真实复制的普通成员，只有固定根 tsx consumer 由 stage 生成 package.json；此
 * 处补齐静态证据闭合，不执行目标 Node 解析，也不把
 * GraphProof 自报结果提升为实际运行证明。
 */
function verifyConsumers(
    report: InputInspection,
    output: readonly OutputFact[],
    tx: ArchiveTransaction,
) {
    const files = new Map(output.map((file) => [file.path, file]));
    for (const graph of [report.nodeReceipt.npmGraph, report.trees.dependencies.receipt.graph]) {
        for (const resolution of graph.resolutionProof.resolutions)
            if (!files.has(resolution.consumer) || !files.has(resolution.resolvedFile))
                tx.fail("PAYLOAD_GRAPH_MISMATCH");
        for (const bin of graph.bins)
            if (
                bin.launcher === "native" &&
                ![0o555, 0o755].includes(files.get(bin.targetPath)?.mode ?? 0)
            )
                tx.fail("PAYLOAD_BIN_UNSUPPORTED");
    }
}

/**
 * ZIP 的第二消费者只用 yauzl 公开 central metadata 施加明确 Unix 原模式政策，并逐项对照 fresh intake 的成员集合；不解压
 * 、不重计同一归档资源，也不试图补造 descriptor 或
 * 完整 ZIP 语法解码器来掩盖 I 的延期模式 fallback。
 */
async function explicitZipModes(intake: IntakeResult, tx: ArchiveTransaction) {
    const archive = intake.receipt.archives.find((item) => item.kind === "chrome")!;
    const path = join(intake.directory, archive.snapshot.path);
    let fd: number | undefined = await new Promise<number>((resolve, reject) =>
        openFd(
            path,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
            (error, value) => (error ? reject(error) : resolve(value)),
        ),
    );
    let zip: ZipFile | undefined,
        closure: ReturnType<typeof trackZipClosure> | undefined,
        primary: unknown;
    const abort = () => closure?.request();
    try {
        const before = await new Promise<import("node:fs").Stats>((resolve, reject) =>
            fstat(fd!, (error, value) => (error ? reject(error) : resolve(value))),
        );
        if (!before.isFile() || before.nlink !== 1 || before.size !== archive.snapshot.sizeBytes)
            tx.fail("PAYLOAD_SOURCE_CHANGED");
        const stream = createReadStream(path, {
            fd,
            autoClose: false,
            start: 0,
            highWaterMark: 64 * 1024,
        });
        const completion = finished(stream);
        completion.catch(() => {});
        const digest = createHash("sha256");
        let bytes = 0;
        try {
            for await (const chunk of stream) {
                tx.check();
                bytes += chunk.length;
                if (bytes > archive.snapshot.sizeBytes) tx.fail("PAYLOAD_SOURCE_CHANGED");
                digest.update(chunk);
            }
            await completion;
        } finally {
            if (!stream.readableEnded) stream.destroy();
            await completion.catch(() => {});
        }
        if (
            bytes !== archive.snapshot.sizeBytes ||
            digest.digest("hex") !== archive.snapshot.sha256
        )
            tx.fail("PAYLOAD_SOURCE_CHANGED");
        zip = await fromFdPromise(fd, {
            autoClose: false,
            lazyEntries: true,
            strictFileNames: true,
        });
        fd = undefined;
        closure = trackZipClosure(zip, tx);
        tx.signal?.addEventListener("abort", abort, { once: true });
        const expected = new Map(archive.members.map((member) => [member.path, member]));
        let count = 0,
            metadata = 0;
        while (true) {
            tx.check();
            const entry = await zipEntry(zip);
            if (!entry) break;
            metadata += entry.fileNameLength + entry.extraFieldLength + entry.fileCommentLength;
            if (
                ++count > 40000 ||
                metadata > 4 * 1024 ** 2 ||
                entry.fileNameLength + entry.extraFieldLength + entry.fileCommentLength > 64 * 1024
            )
                tx.fail("PAYLOAD_LIMIT");
            const raw = entry.externalFileAttributes >>> 16,
                type = raw & 0o170000;
            if (
                entry.versionMadeBy >>> 8 !== 3 ||
                !raw ||
                ![0o100000, 0o040000, 0o120000].includes(type) ||
                !(raw & 0o777) ||
                raw & 0o7000
            )
                tx.fail("PAYLOAD_ARCHIVE_UNSUPPORTED");
            const kind: ArchiveMember["kind"] =
                type === 0o040000 ? "directory" : type === 0o120000 ? "link" : "file";
            const name =
                kind === "directory" && entry.fileName.endsWith("/")
                    ? entry.fileName.slice(0, -1)
                    : entry.fileName;
            const member = expected.get(name);
            if (
                !member ||
                member.kind !== kind ||
                member.mode !== (raw & 0o777) ||
                (kind === "directory") !== entry.fileName.endsWith("/")
            )
                tx.fail("PAYLOAD_ARCHIVE_UNSUPPORTED");
            expected.delete(name);
        }
        if (expected.size || closure.failure()) tx.fail("PAYLOAD_ARCHIVE_UNSUPPORTED");
    } catch (error) {
        primary = error;
        throw error;
    } finally {
        tx.signal?.removeEventListener("abort", abort);
        try {
            if (closure) await closure.settle();
            else if (fd !== undefined) await closeUntransferredZipFd(fd, tx);
        } catch (error) {
            tx.noteCloseFailure();
            if (!primary) throw error;
        }
    }
}

/**
 * 每次 metadata 请求只保留当前 entry、结束和错误监听，任一完成后立即卸载其它监听避免旧事件影响下一成员；取消导致的关闭
 * 也明确拒绝，库不会预取下一条目或访问 yauzl 私有状态来猜测收尾事实。
 */
function zipEntry(zip: ZipFile): Promise<Entry | null> {
    return new Promise((resolve, reject) => {
        const clear = () => {
            zip.removeListener("entry", entry);
            zip.removeListener("end", end);
            zip.removeListener("error", error);
            zip.removeListener("close", close);
        };
        const entry = (value: Entry) => {
                clear();
                resolve(value);
            },
            end = () => {
                clear();
                resolve(null);
            },
            error = (value: unknown) => {
                clear();
                reject(value);
            },
            close = () => {
                clear();
                reject(new RuntimePayloadError("PAYLOAD_CANCELLED"));
            };
        zip.once("entry", entry);
        zip.once("end", end);
        zip.once("error", error);
        zip.once("close", close);
        zip.readEntry();
    });
}
