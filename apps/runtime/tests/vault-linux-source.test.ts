import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

test(
    "Linux vault source evidence binds the exact committed workflow bytes",
    { skip: process.platform !== "linux" },
    async () => {
        const root = await mkdtemp(join(tmpdir(), "veriq-vault-source-"));
        try {
            const cwd = join(root, "apps/runtime");
            const workflow = ".github/workflows/runtime-vault-linux.yml";
            const script = resolve("scripts/vault-linux-evidence.mjs");
            const bytes = await readFile(resolve("../..", workflow));
            const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
            await mkdir(cwd, { recursive: true });
            await mkdir(join(root, ".github/workflows"), { recursive: true });
            await writeFile(join(root, workflow), bytes);
            git("init", "--quiet");
            git("add", workflow);
            git(
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.invalid",
                "commit",
                "--no-gpg-sign",
                "-qm",
                "fixture",
            );
            const source = (sha: string, evidence: string) =>
                execFileSync(process.execPath, [script, "source"], {
                    cwd,
                    env: { ...process.env, GITHUB_SHA: sha, VERIQ_VAULT_EVIDENCE: join(root, evidence) },
                    stdio: "pipe",
                });
            const commit = git("rev-parse", "HEAD");
            source(commit, "complete");
            const binding = JSON.parse(await readFile(join(root, "complete/source-binding.json"), "utf8"));
            assert.equal(binding.source, commit);
            assert.equal(binding.files[workflow], createHash("sha256").update(bytes).digest("hex"));
            assert.throws(() => source("0".repeat(40), "wrong-commit"), /VAULT_SOURCE_COMMIT_MISMATCH/);
            await writeFile(join(root, workflow), Buffer.concat([bytes, Buffer.from("\n")]));
            assert.throws(() => source(commit, "modified"), /VAULT_SOURCE_BYTES_MISMATCH/);
            await assert.rejects(readFile(join(root, "modified/source-binding.json")), { code: "ENOENT" });
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    },
);
