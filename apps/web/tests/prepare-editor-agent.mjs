/** Test-only actual locked engine release; no fabricated receipt/publication. */
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  copyFileSync,
  rmSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { resolve, dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
const root = resolve(".superpowers/cache/t11");
const hash = createHash("sha256");
function sources(path) {
  for (const file of readdirSync(path, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const p = join(path, file.name);
    if (file.isDirectory()) sources(p);
    else {
      hash.update(p);
      hash.update(readFileSync(p));
    }
  }
}
for (const pkg of ["compiler", "runner-sdk", "contracts"]) {
  sources("packages/" + pkg + "/src");
  hash.update(readFileSync("packages/" + pkg + "/package.json"));
}
sources("packages/contracts/schemas");
hash.update(readFileSync("pnpm-lock.yaml"));
const fingerprint = hash.digest("hex");
const stamp = join(root, "fingerprint");
const build = join(root, "build");
const release = join(root, "release");
mkdirSync(root, { recursive: true });
execFileSync("pnpm", ["--filter", "@veriq/runtime", "build:launcher"], {
  stdio: "inherit",
});
if (
  existsSync(stamp) &&
  readFileSync(stamp, "utf8") === fingerprint &&
  existsSync(join(release, "inventory.json"))
)
  process.exit(0);
// Bootstrapping only an engine archive, never inserting resource versions or receipts.
const source = join(root, "source.json");
writeFileSync(source, "{}");
try {
  execFileSync(
    process.execPath,
    [
      "--import",
      "../contracts/node_modules/tsx/dist/loader.mjs",
      "tests/queue-fixture.ts",
      source,
      build,
      "--expect-failure",
    ],
    { cwd: "packages/runner-sdk", stdio: "inherit" },
  );
  const index = JSON.parse(readFileSync(join(build, "index.json"), "utf8"));
  mkdirSync(release, { recursive: true });
  writeFileSync(
    join(release, "inventory.json"),
    JSON.stringify(index.inventory),
  );
  for (const file of index.inventory.engines[0].files) {
    const target = join(release, file.path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(build, file.sha256), target);
  }
  writeFileSync(stamp, fingerprint);
} finally {
  rmSync(build, { recursive: true, force: true });
  rmSync(source, { force: true });
}
