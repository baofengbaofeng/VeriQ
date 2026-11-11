import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, createHash } from "node:crypto";
import {
  mkdtemp,
  writeFile,
  readFile,
  rm,
  chmod,
  readdir,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { canonicalBytes, assetSourceBytes } from "@veriq/contracts";
import {
  snapshot,
  asset,
  id,
} from "../../../packages/compiler/tests/helpers.ts";
import { verifyBundle } from "../src/offline/verify.ts";
import { TrustStore, type IssuerTrust } from "../src/offline/trust.ts";
import { SecretStore, SecretResolver } from "../src/credentials/store.ts";
const sha = (raw: Uint8Array) => createHash("sha256").update(raw).digest("hex");
async function cleanup(path: string) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isDirectory()) await cleanup(join(path, entry.name));
  }
  await chmod(path, 0o700);
}
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "veriq-offline-")),
    pair = generateKeyPairSync("ed25519"),
    raw = pair.publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const issuer: IssuerTrust = {
    issuerId: "test_issuer",
    revision: 1,
    keys: [
      {
        keyId: "key_1",
        algorithm: "Ed25519",
        publicKey: raw.toString("base64"),
        fingerprint: sha(raw),
        revoked: false,
      },
    ],
  };
  const trust = new TrustStore(join(dir, "trust"));
  await trust.bind(issuer, "https://control.test", issuer.keys[0]!.fingerprint);
  async function archive(
    opts: {
      extra?: string;
      mutate?: boolean;
      expired?: boolean;
      debug?: boolean;
      unsigned?: boolean;
      duplicate?: boolean;
      link?: boolean;
      payload?: Buffer;
      directoryCollision?: boolean;
    } = {},
  ) {
    const source = snapshot(undefined, [
      asset(3, "ENVIRONMENT", {
        schemaVersion: "1.0",
        baseURL: "https://business.test",
        apiBaseURL: "https://business.test",
        allowedOrigins: ["https://business.test"],
        locale: "en",
        timezone: "UTC",
        roles: [
          {
            roleKey: "reader",
            authAdapterVersionId: id(13),
            secretRef: "reader",
            secretVersionId: id(14),
          },
        ],
      }),
    ]);
    const files: Record<string, Buffer> = {
      "snapshot.json": Buffer.from(canonicalBytes(source)),
      "value.txt": opts.payload ?? Buffer.from("original"),
    };
    const put = (path: string, value: unknown) => {
      files[path] = Buffer.from(canonicalBytes(value));
    };
    put("selection.json", {
      caseVersionIds: [id(1)],
      environmentVersionId: id(3),
      validationStatus: opts.debug ? "UNVALIDATED_DEBUG" : "VALIDATED",
    });
    put("resources.json", {
      resources: source.assets.map((a) => ({
        id: a.resourceId,
        workspaceId: source.workspaceId,
        kind: a.kind,
        key: "resource_" + a.versionId,
        name: "Resource",
        status: "PUBLISHED",
        latestVersionId: a.versionId,
      })),
      versions: source.assets.map((a) => ({
        id: a.versionId,
        resourceId: a.resourceId,
        workspaceId: source.workspaceId,
        versionNo: 1,
        schemaVersion: "1.0",
        sha256: a.sha256,
        content: { kind: a.kind, document: a.document },
        publishedAt: "2020-01-01T00:00:00Z",
      })),
    });
    for (const a of source.assets) {
      put(`assets/${a.versionId}.json`, a);
      const original = {
        schemaVersion: "1.0",
        workspaceId: source.workspaceId,
        engineVersion: source.engineVersion,
        sourceHash: "",
        entryCaseVersionIds: a.kind === "CASE" ? [a.versionId] : [],
        assets:
          a.kind === "CASE"
            ? source.assets.filter((x) => x.kind !== "ENVIRONMENT")
            : [a],
        validationTarget: {
          resourceId: a.resourceId,
          versionId: a.versionId,
          revision: 1,
        },
      };
      original.sourceHash = sha(assetSourceBytes(original));
      const code = Buffer.from("export {};"),
        entry = {
          path: "validation.ts",
          sha256: sha(code),
          sizeBytes: code.length,
        };
      const descriptor = {
        schemaVersion: "1.0",
        sourceHash: original.sourceHash,
        engineVersion: "0.1.0",
        compilerVersion: "0.1.0",
        runnerSdkVersion: "0.1.0",
        entrypoints:
          a.kind === "CASE"
            ? [{ caseVersionId: a.versionId, path: "validation.ts" }]
            : [],
        ...(a.kind !== "CASE" ? { validationOnly: true } : {}),
        files: [entry],
        dependencies: [
          {
            name: "@veriq/runner-sdk",
            version: "0.1.0",
            integrity: "sha256-" + sha(code),
          },
        ],
      };
      put(`provenance/${a.versionId}/source.json`, original);
      put(`provenance/${a.versionId}/descriptor.json`, descriptor);
      put(`provenance/${a.versionId}/receipt.json`, {
        sourceHash: original.sourceHash,
        compiledBundleSha256: sha(canonicalBytes(descriptor)),
        engineVersion: "0.1.0",
        compilerTrust: "MANAGED",
        revision: 1,
      });
      files[`compiled/${a.versionId}/validation.ts`] = code;
    }
    const engineFiles = [
      "package.json",
      "package-lock.json",
      "dependencies.json",
    ].map((path) => {
      const body = Buffer.from("{}");
      files["engine/" + path] = body;
      return { path, sha256: sha(body), sizeBytes: body.length };
    });
    put("engine/inventory.json", {
      schemaVersion: "1.0",
      engines: [
        {
          engineVersion: "0.1.0",
          compilerVersion: "0.1.0",
          runnerSdkVersion: "0.1.0",
          files: engineFiles,
          dependencies: [],
        },
      ],
    });
    if (opts.directoryCollision) {
      files["Folder/a.txt"] = Buffer.from("a");
      files["folder/b.txt"] = Buffer.from("b");
    }
    const manifest = {
      schemaVersion: "1.0",
      bundleId: "00000000-0000-4000-8000-000000000010",
      workspaceId: source.workspaceId,
      issuerId: issuer.issuerId,
      keyId: "key_1",
      createdAt: "2020-01-01T00:00:00Z",
      expiresAt: opts.expired ? "2021-01-01T00:00:00Z" : "2099-01-01T00:00:00Z",
      sourceHash: source.sourceHash,
      snapshotSha256: sha(files["snapshot.json"]!),
      engineVersion: "0.1.0",
      validationStatus: opts.debug ? "UNVALIDATED_DEBUG" : "VALIDATED",
      files: Object.entries(files).map(([path, body]) => ({
        path,
        sha256: sha(body),
        sizeBytes: body.length,
      })),
    };
    const manifestRaw = Buffer.from(canonicalBytes(manifest));
    files["manifest.json"] = manifestRaw;
    files["manifest.sig"] = opts.unsigned
      ? Buffer.alloc(64)
      : sign(null, manifestRaw, pair.privateKey);
    if (opts.mutate) files["value.txt"] = Buffer.from("tampered");
    if (opts.extra) files[opts.extra] = Buffer.from("extra");
    const input = join(dir, "entries.json"),
      output = join(dir, "bundle.zip");
    await writeFile(
      input,
      JSON.stringify({
        files: Object.fromEntries(
          Object.entries(files).map(([k, v]) => [k, v.toString("base64")]),
        ),
        duplicate: opts.duplicate,
        link: opts.link,
      }),
    );
    execFileSync("python", [
      "-c",
      `import json,base64,zipfile,sys
v=json.load(open(sys.argv[1]))
with zipfile.ZipFile(sys.argv[2],'w',compression=zipfile.ZIP_DEFLATED) as z:
 for n,b in v['files'].items():
  info=zipfile.ZipInfo(n);info.external_attr=((0o120777 if v.get('link') and n=='value.txt' else 0o100600)<<16);info.compress_type=zipfile.ZIP_DEFLATED;z.writestr(info,base64.b64decode(b))
 if v.get('duplicate'): z.writestr('VALUE.txt',b'x')`,
      input,
      output,
    ]);
    return output;
  }
  return {
    dir,
    trust,
    issuer,
    archive,
    close: async () => {
      await cleanup(dir);
      await rm(dir, { recursive: true, force: true });
    },
  };
}
test("signed bytes require a separately trusted root; tamper/extra/link/portable-path collisions fail before publication", async () => {
  const f = await fixture();
  try {
    const bundle = await f.archive();
    const result = await verifyBundle(bundle, {
      trust: f.trust,
      destination: join(f.dir, "valid"),
    });
    assert.equal(result.revocationStatus, "UNKNOWN");
    assert.equal(result.formalGateEligible, false);
    assert.equal(
      await readFile(join(f.dir, "valid/value.txt"), "utf8"),
      "original",
    );
    await assert.rejects(
      verifyBundle(bundle, {
        trust: new TrustStore(join(f.dir, "untrusted")),
        destination: join(f.dir, "no-root"),
      }),
      /ISSUER_NOT_TRUSTED/,
    );
    for (const options of [
      { mutate: true },
      { extra: "extra.txt" },
      { extra: "../escape" },
      { extra: "AUX.txt" },
      { extra: "ads:secret" },
      { extra: "trailing." },
      { extra: "back\\slash" },
      { duplicate: true },
      { link: true },
      { unsigned: true },
    ]) {
      const input = await f.archive(options);
      const destination = join(f.dir, "reject");
      await assert.rejects(
        verifyBundle(input, { trust: f.trust, destination }),
      );
      await assert.rejects(stat(destination), { code: "ENOENT" });
    }
  } finally {
    await f.close();
  }
});
test("expiry and debug require explicit consent, revoked keys remain rejected; rotation cannot replace or roll back trust", async () => {
  const f = await fixture();
  try {
    const archive = await f.archive({ expired: true });
    await assert.rejects(
      verifyBundle(archive, {
        trust: f.trust,
        destination: join(f.dir, "expired"),
      }),
      /BUNDLE_EXPIRED/,
    );
    assert.equal(
      (
        await verifyBundle(archive, {
          trust: f.trust,
          destination: join(f.dir, "debug"),
          debug: true,
        })
      ).debug,
      true,
    );
    const state = structuredClone(f.issuer);
    state.revision++;
    state.keys[0]!.revoked = true;
    // OOB refresh can record revocations when another non-revoked trusted key is present.
    const replacement = generateKeyPairSync("ed25519")
      .publicKey.export({ format: "der", type: "spki" })
      .subarray(-32);
    state.keys.push({
      keyId: "key_2",
      algorithm: "Ed25519",
      publicKey: replacement.toString("base64"),
      fingerprint: sha(replacement),
      revoked: false,
    });
    await f.trust.bind(
      state,
      "https://control.test",
      state.keys[1]!.fingerprint,
    );
    await assert.rejects(
      verifyBundle(archive, {
        trust: f.trust,
        destination: join(f.dir, "revoked"),
        debug: true,
      }),
      /ISSUER_KEY_REVOKED/,
    );
    await assert.rejects(
      f.trust.bind(
        f.issuer,
        "https://control.test",
        f.issuer.keys[0]!.fingerprint,
      ),
      /ISSUER_ROLLBACK/,
    );
    const altered = structuredClone(state);
    altered.revision++;
    altered.keys[0] = { ...state.keys[1]!, keyId: "key_1" };
    await assert.rejects(
      f.trust.bind(altered, "https://control.test", state.keys[1]!.fingerprint),
      /ISSUER_REPLACEMENT/,
    );
  } finally {
    await f.close();
  }
});
test("restricted local mapping binds issuer/workspace/exact version and never falls back", async () => {
  const f = await fixture();
  try {
    const store = new SecretStore(join(f.dir, "credentials"));
    const ref = {
      issuerId: "test_issuer",
      workspaceId: "00000000-0000-4000-8000-000000000099",
      secretRef: "local",
      versionId: "00000000-0000-4000-8000-000000000001",
    };
    await store.set(ref, { token: "private-local-value" });
    const resolver = new SecretResolver(store),
      attempt = {
        issuerId: ref.issuerId,
        workspaceId: ref.workspaceId,
        secretVersions: [
          { secretRef: ref.secretRef, versionId: ref.versionId },
        ],
      };
    assert.deepEqual(await resolver.resolve(ref, attempt), {
      token: "private-local-value",
    });
    await assert.rejects(
      resolver.resolve({ ...ref, issuerId: "foreign" }, attempt),
      /CREDENTIAL_SCOPE_MISMATCH/,
    );
    await assert.rejects(
      store.resolve({
        ...ref,
        versionId: "00000000-0000-4000-8000-000000000002",
      }),
      /LOCAL_CREDENTIAL_MISSING/,
    );
    assert.equal(
      (await stat(join(f.dir, "credentials/local-secrets.json"))).mode & 0o077,
      0,
    );
    await store.clear();
    await assert.rejects(store.resolve(ref), /LOCAL_CREDENTIAL_MISSING/);
    assert.equal((await f.trust.issuer("test_issuer")).issuerId, "test_issuer");
  } finally {
    await f.close();
  }
});

test("signed portable directory aliases and compressed oversize members are rejected before install", async () => {
  const f = await fixture();
  try {
    const collision = await f.archive({ directoryCollision: true });
    await assert.rejects(
      verifyBundle(collision, {
        trust: f.trust,
        destination: join(f.dir, "collision"),
      }),
      /UNSAFE_ARCHIVE/,
    );
    const bomb = await f.archive({ payload: Buffer.alloc(17 * 1024 * 1024) });
    await assert.rejects(
      verifyBundle(bomb, { trust: f.trust, destination: join(f.dir, "bomb") }),
      /UNSAFE_ARCHIVE/,
    );
  } finally {
    await f.close();
  }
});
