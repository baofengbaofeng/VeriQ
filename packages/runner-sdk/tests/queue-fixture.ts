/** Test-only actual-byte producer. Never imported by production controller/runtime. */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { actualDistribution } from "./distribution.js";
import { compileFiles, COMPILER_VERSION } from "../../compiler/src/index.js";
import { canonicalBytes } from "@veriq/contracts";
const [sourcePath, root, mode] = process.argv.slice(2) as [string, string, string?];
mkdirSync(root, { recursive: true });
const distribution = actualDistribution(root);
let output: ReturnType<typeof compileFiles> | undefined;
let diagnostic: string | undefined;
try {
  output = compileFiles(JSON.parse(readFileSync(sourcePath, "utf8")), distribution);
} catch (error) {
  if (mode !== "--expect-failure" || !(error instanceof Error)) throw error;
  diagnostic = error.message.slice(0, 4096);
}
if (mode === "--expect-failure" && output) throw new Error("Expected actual compiler failure");
const files: Record<string, Uint8Array> = output?.files ?? {
  ...distribution.files,
  "package.json": canonicalBytes(JSON.parse(Buffer.from(distribution.packageJson).toString())),
  "package-lock.json": canonicalBytes(JSON.parse(Buffer.from(distribution.packageLock).toString())),
  "dependencies.json": canonicalBytes(distribution.dependencies),
};
const compiler = join(root, "compiler.tgz");
execFileSync("tar", ["-czf", compiler, "-C", "../compiler", "src", "package.json"]);
const bytes = readFileSync(compiler);
const hash = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const fixed = Object.entries(files).map(([path, content]) => ({ path, sha256: hash(content), sizeBytes: content.length })).filter((f) => ["package.json", "package-lock.json", "dependencies.json"].includes(f.path) || f.path.startsWith("vendor/"));
const engine = { engineVersion: distribution.engineVersion, compilerVersion: COMPILER_VERSION,
  runnerSdkVersion: distribution.runnerSdkVersion, dependencies: distribution.dependencies,
  files: [...fixed, { path: "engine/compiler.tgz", sha256: hash(bytes), sizeBytes: bytes.length }] };
files["engine/compiler.tgz"] = bytes;
if (diagnostic) writeFileSync(join(root, "failure.log"), diagnostic);
const records = [];
for (const [path, content] of Object.entries(files)) {
  const sha256 = hash(content);
  writeFileSync(join(root, sha256), content);
  records.push({ path, sha256, sizeBytes: content.length });
}
if (output) writeFileSync(join(root, "bundle.json"), canonicalBytes(output.bundle));
writeFileSync(join(root, "index.json"), JSON.stringify({ failed: !!diagnostic, files: records, inventory: { schemaVersion: "1.0", engines: [engine] }, inventoryHash: hash(canonicalBytes(engine)) }));
