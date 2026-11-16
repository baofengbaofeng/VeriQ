import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { renderBinShim } from "../scripts/runtime-payload-bins.ts";
import type { Bin } from "../scripts/runtime-payload-inputs.ts";

for (const launcher of ["node", "native"] as const)
    test(`${launcher} shim preserves target location and literal argv without PATH node`, async () => {
        const root = await mkdtemp(join(tmpdir(), "VeriQ shim 中文 空格 ' $ ` "));
        try {
            const bin: Bin = {
                owner: "p1",
                name: "tool",
                aliasPath: "node_modules/.bin/tool",
                sourceAlias: null,
                targetPath: "node_modules/pkg' $& `/bin/tool.js",
                targetSha256: "a".repeat(64),
                launcher,
                inspection: null,
            };
            const alias = join(root, bin.aliasPath),
                target = join(root, bin.targetPath);
            await mkdir(dirname(alias), { recursive: true });
            await mkdir(dirname(target), { recursive: true });
            await mkdir(join(root, "roles/runner"), { recursive: true });
            // 单独测试载体只位于候选之外的微型目录，通过明确宿主 Node 执行原 JavaScript 来观察相对 require 和原始参数；它既不复制宿主二进制，也不会被报告为有效 Mac 角色或进入 stage 输出
            // 。
            const carrier = `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' "$@"\n`;
            await writeFile(join(root, "roles/runner/veriq_runner"), carrier, { mode: 0o755 });
            await writeFile(
                join(dirname(dirname(target)), "value.cjs"),
                "module.exports='original package';\n",
            );
            await writeFile(
                target,
                launcher === "node"
                    ? "const fs=require('node:fs');fs.writeFileSync(process.argv[2],JSON.stringify([require('../valu" +
                          "e.cjs'),...process.argv.slice(3)]));\n"
                    : `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}` +
                          `' -e 'require("node:fs").writeFileSync(process.argv[1],JSON.stringify(process.argv.slice(2` +
                          `)))' "$@"\n`,
            );
            await chmod(target, 0o755);
            await writeFile(alias, renderBinShim(bin), { mode: 0o755 });
            const output = join(root, "result.json"),
                argv = ["中文 空格", "'quoted'", "$HOME", "`id`", "--flag"];
            execFileSync(alias, [output, ...argv], { env: { PATH: "/nonexistent" } });
            assert.deepEqual(
                JSON.parse(await readFile(output, "utf8")),
                launcher === "node" ? ["original package", ...argv] : argv,
            );
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
