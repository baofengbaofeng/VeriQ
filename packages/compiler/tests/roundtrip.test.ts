import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import ts from "typescript";
import { expect, it } from "vitest";
import {
  compileFiles,
  assembleExecution,
  type EngineDistribution,
} from "../src/index.js";
import { snapshot } from "./helpers.js";
it("installs actual fixture archive from emitted lock offline and typechecks generated registration", () => {
  const root = mkdtempSync(join(tmpdir(), "veriq-codegen-"));
  try {
    const sdk = join(root, "fixture", "package");
    mkdirSync(sdk, { recursive: true });
    writeFileSync(
      join(sdk, "package.json"),
      JSON.stringify({
        name: "@veriq/runner-sdk",
        version: "0.1.0",
        type: "module",
        exports: { types: "./index.d.ts", default: "./index.js" },
      }),
    );
    // This deliberately does not implement browser execution. It tests packaging and the import ABI only.
    writeFileSync(
      join(sdk, "index.js"),
      'export function registerCase() { throw new Error("Fixture SDK cannot execute tests"); }\n',
    );
    writeFileSync(
      join(sdk, "index.d.ts"),
      "export declare function registerCase(plan: {caseVersionId:string;steps:unknown[]}, source:{workspaceId:string;sourceHash:string}): void;\n",
    );
    const tarPath = join(root, "sdk.tgz");
    execFileSync("tar", [
      "-czf",
      tarPath,
      "-C",
      join(root, "fixture"),
      "package",
    ]);
    const tar = readFileSync(tarPath);
    const integrity =
      "sha512-" + createHash("sha512").update(tar).digest("base64");
    const pkg = {
      name: "veriq-generated",
      version: "0.1.0",
      private: true,
      type: "module",
      dependencies: { "@veriq/runner-sdk": "file:vendor/sdk.tgz" },
    };
    const lock = {
      name: pkg.name,
      version: pkg.version,
      lockfileVersion: 3,
      packages: {
        "": pkg,
        "node_modules/@veriq/runner-sdk": {
          version: "0.1.0",
          resolved: "file:vendor/sdk.tgz",
          integrity,
        },
      },
    };
    const dist: EngineDistribution = {
      engineVersion: "0.1.0",
      runnerSdkVersion: "0.1.0",
      packageJson: Buffer.from(JSON.stringify(pkg)),
      packageLock: Buffer.from(JSON.stringify(lock)),
      dependencies: [
        { name: "@veriq/runner-sdk", version: "0.1.0", integrity },
      ],
      files: { "vendor/sdk.tgz": tar },
    };
    const emitted = compileFiles(snapshot(), dist);
    const output = join(root, "emitted");
    mkdirSync(output);
    for (const [path, bytes] of Object.entries(emitted.files)) {
      mkdirSync(dirname(join(output, path)), { recursive: true });
      writeFileSync(join(output, path), bytes);
    }
    execFileSync(
      "npm",
      [
        "ci",
        "--offline",
        "--ignore-scripts",
        "--audit=false",
        "--fund=false",
        "--cache",
        join(root, "npm-cache"),
      ],
      { cwd: output, stdio: "pipe" },
    );
    const program = ts.createProgram(
      [join(output, emitted.bundle.entrypoints[0]!.path)],
      {
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        target: ts.ScriptTarget.ES2023,
        noEmit: true,
        strict: true,
        skipLibCheck: true,
        types: [],
      },
    );
    expect(
      ts
        .getPreEmitDiagnostics(program)
        .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")),
    ).toEqual([]);
    const restored = Object.fromEntries(
      emitted.bundle.files.map((f) => [
        f.path,
        readFileSync(join(output, f.path)),
      ]),
    );
    expect(restored).toEqual(
      Object.fromEntries(
        Object.entries(emitted.files).map(([k, v]) => [k, Buffer.from(v)]),
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
