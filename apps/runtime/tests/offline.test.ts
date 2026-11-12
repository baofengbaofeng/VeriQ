import { test, mock } from "node:test";
import { updatePrivate } from "../src/offline/config.ts";
import { RuntimeClient, type DeviceConfig } from "../src/enrollment.ts";
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
import { compileFiles, type EngineDistribution } from "@veriq/compiler";
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
      inconsistent?:
        | "entries"
        | "adapter"
        | "engine"
        | "entrypoints"
        | "validationOnly"
        | "dependencies";
      signing?: { keyId: string; privateKey: typeof pair.privateKey };
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
    const configuration = {
      kind: "HTTP_BEARER" as const,
      identityPath: "/me",
      identityPointer: "/id",
    };
    source.authAdapters = [
      {
        workspaceId: source.workspaceId,
        versionId: id(13),
        configuration,
        contentHash: sha(canonicalBytes(configuration)),
      },
    ];
    source.sourceHash = sha(assetSourceBytes(source));
    const vendor = Buffer.from("isolated dependency byte fixture");
    const dependencies = [
      {
        name: "@veriq/runner-sdk",
        version: "0.1.0",
        integrity:
          "sha512-" + createHash("sha512").update(vendor).digest("base64"),
      },
    ];
    const distribution: EngineDistribution = {
      engineVersion: "0.1.0",
      runnerSdkVersion: "0.1.0",
      dependencies,
      packageJson: canonicalBytes({
        name: "veriq-generated",
        type: "module",
        dependencies: { "@veriq/runner-sdk": "file:vendor/sdk.tgz" },
      }),
      packageLock: canonicalBytes({
        lockfileVersion: 3,
        packages: {
          "": { dependencies: { "@veriq/runner-sdk": "file:vendor/sdk.tgz" } },
          "node_modules/@veriq/runner-sdk": {
            version: "0.1.0",
            resolved: "file:vendor/sdk.tgz",
            integrity: dependencies[0]!.integrity,
          },
        },
      }),
      files: { "vendor/sdk.tgz": vendor },
    };
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
        ...(a.kind === "ENVIRONMENT"
          ? { authAdapters: source.authAdapters }
          : {}),
        validationTarget: {
          resourceId: a.resourceId,
          versionId: a.versionId,
          revision: 1,
        },
      };
      original.sourceHash = sha(assetSourceBytes(original));
      const compiled = compileFiles(original as typeof source, distribution),
        descriptor = compiled.bundle;
      put(`provenance/${a.versionId}/source.json`, original);
      put(`provenance/${a.versionId}/descriptor.json`, descriptor);
      put(`provenance/${a.versionId}/receipt.json`, {
        sourceHash: original.sourceHash,
        compiledBundleSha256: sha(canonicalBytes(descriptor)),
        engineVersion: "0.1.0",
        compilerTrust: "MANAGED",
        revision: 1,
      });
      for (const [path, bytes] of Object.entries(compiled.files))
        files[`compiled/${a.versionId}/${path}`] = Buffer.from(bytes);
    }
    const engineFiles = [
      "package.json",
      "package-lock.json",
      "dependencies.json",
    ].map((path) => {
      const body = Buffer.from(
        path === "package.json"
          ? distribution.packageJson
          : path === "package-lock.json"
            ? distribution.packageLock
            : canonicalBytes(dependencies),
      );
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
          dependencies,
        },
      ],
    });
    if (opts.directoryCollision) {
      files["Folder/a.txt"] = Buffer.from("a");
      files["folder/b.txt"] = Buffer.from("b");
    }
    if (opts.inconsistent) {
      const update = (path: string, change: (value: any) => void) => {
        const value = JSON.parse(files[path]!.toString());
        change(value);
        put(path, value);
        return value;
      };
      if (opts.inconsistent === "entries" || opts.inconsistent === "adapter") {
        if (opts.inconsistent === "entries")
          source.entryCaseVersionIds = [id(999)];
        else
          source.authAdapters = [
            {
              workspaceId: id(999),
              versionId: id(13),
              configuration: {
                kind: "HTTP_BEARER",
                identityPath: "/me",
                identityPointer: "/id",
              },
              contentHash: "0".repeat(64),
            },
          ];
        source.sourceHash = sha(assetSourceBytes(source));
        put("snapshot.json", source);
      } else if (opts.inconsistent === "engine") {
        update("engine/inventory.json", (v) => {
          v.engines[0].compilerVersion = "9.9.9";
          v.engines[0].runnerSdkVersion = "9.9.9";
        });
      } else {
        const path = `provenance/${id(1)}/descriptor.json`;
        update(path, (v) => {
          if (opts.inconsistent === "entrypoints")
            v.entrypoints[0].caseVersionId = id(999);
          if (opts.inconsistent === "validationOnly") v.validationOnly = true;
          if (opts.inconsistent === "dependencies")
            v.dependencies[0].version = "9.9.9";
        });
        update(`provenance/${id(1)}/receipt.json`, (v) => {
          v.compiledBundleSha256 = sha(files[path]!);
        });
      }
    }
    const manifest = {
      schemaVersion: "1.0",
      bundleId: "00000000-0000-4000-8000-000000000010",
      workspaceId: source.workspaceId,
      issuerId: issuer.issuerId,
      keyId: opts.signing?.keyId ?? "key_1",
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
      : sign(null, manifestRaw, opts.signing?.privateKey ?? pair.privateKey);
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
    // Authenticated exact-origin transport establishes complete rotation/revocation metadata.
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
    const config = {
      server: "https://control.test",
      deviceToken: "synthetic-device",
    } as DeviceConfig;
    let remote = state;
    const request = mock.method(
      RuntimeClient.prototype,
      "request",
      async function (
        path: string,
        method: string,
        _body: unknown,
        token: string,
      ) {
        assert.equal(path, "/internal/v1/issuer");
        assert.equal(method, "GET");
        assert.equal(token, config.deviceToken);
        return remote;
      },
    );
    await f.trust.refresh(config);
    await assert.rejects(
      verifyBundle(archive, {
        trust: f.trust,
        destination: join(f.dir, "revoked"),
        debug: true,
      }),
      /ISSUER_KEY_REVOKED/,
    );
    remote = f.issuer;
    await assert.rejects(f.trust.refresh(config), /ISSUER_ROLLBACK/);
    await assert.rejects(
      f.trust.bind(
        f.issuer,
        "https://control.test",
        f.issuer.keys[0]!.fingerprint,
      ),
      /ISSUER_KEY_REVOKED/,
    );
    const altered = structuredClone(state);
    altered.revision++;
    altered.keys[0] = { ...state.keys[1]!, keyId: "key_1" };
    remote = altered;
    await assert.rejects(f.trust.refresh(config), /ISSUER_REPLACEMENT/);
    request.mock.restore();
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

test("OOB fingerprint never admits appended signers or their unsigned revision", async () => {
  const f = await fixture();
  try {
    const attacker = generateKeyPairSync("ed25519");
    const raw = attacker.publicKey
      .export({ format: "der", type: "spki" })
      .subarray(-32);
    const injected = {
      ...f.issuer,
      revision: 999999,
      keys: [
        ...f.issuer.keys,
        {
          keyId: "attacker",
          algorithm: "Ed25519" as const,
          publicKey: raw.toString("base64"),
          fingerprint: sha(raw),
          revoked: false,
        },
      ],
    };
    for (const trust of [new TrustStore(join(f.dir, "first-bind")), f.trust]) {
      await trust.bind(
        injected,
        "https://control.test",
        f.issuer.keys[0]!.fingerprint,
      );
      const input = await f.archive({
        signing: { keyId: "attacker", privateKey: attacker.privateKey },
      });
      const destination = join(f.dir, "injected");
      await assert.rejects(
        verifyBundle(input, { trust, destination }),
        /ISSUER_KEY/,
      );
      await assert.rejects(stat(destination), { code: "ENOENT" });
      assert.notEqual(
        (await trust.issuer(f.issuer.issuerId)).revision,
        injected.revision,
      );
    }
  } finally {
    await f.close();
  }
});

for (const inconsistent of [
  "entries",
  "adapter",
  "engine",
  "entrypoints",
  "validationOnly",
  "dependencies",
] as const) {
  test(`signed inconsistent ${inconsistent} is rejected before install`, async () => {
    const f = await fixture();
    try {
      const input = await f.archive({ inconsistent }),
        destination = join(f.dir, "semantic");
      await assert.rejects(
        verifyBundle(input, { trust: f.trust, destination }),
        /BUNDLE_/,
      );
      await assert.rejects(stat(destination), { code: "ENOENT" });
    } finally {
      await f.close();
    }
  });
}

test("unsigned metadata cannot poison authenticated revisions; legacy revocations deny aliases after rebind", async () => {
  const f = await fixture();
  try {
    const rotated = generateKeyPairSync("ed25519"),
      raw = rotated.publicKey
        .export({ format: "der", type: "spki" })
        .subarray(-32);
    const key = {
      keyId: "rotation",
      algorithm: "Ed25519" as const,
      publicKey: raw.toString("base64"),
      fingerprint: sha(raw),
      revoked: false,
    };
    await f.trust.bind(
      {
        ...f.issuer,
        revision: Number.MAX_SAFE_INTEGER,
        keys: [...f.issuer.keys, key],
      },
      "https://control.test",
      f.issuer.keys[0]!.fingerprint,
    );
    const config = {
      server: "https://control.test",
      deviceToken: "synthetic-device",
    } as DeviceConfig;
    const request = mock.method(
      RuntimeClient.prototype,
      "request",
      async () => ({ ...f.issuer, revision: 2, keys: [...f.issuer.keys, key] }),
    );
    try {
      await f.trust.refresh(config);
    } finally {
      request.mock.restore();
    }
    const archive = await f.archive({
      signing: { keyId: key.keyId, privateKey: rotated.privateKey },
    });
    await verifyBundle(archive, {
      trust: f.trust,
      destination: join(f.dir, "rotated"),
    });
    const directory = join(f.dir, "legacy"),
      legacy = new TrustStore(directory);
    await updatePrivate(directory, "trust.json", () => ({
      origins: { "https://control.test": f.issuer.issuerId },
      issuers: {
        [f.issuer.issuerId]: {
          ...f.issuer,
          keys: [{ ...f.issuer.keys[0]!, revoked: true }, key],
        },
      },
    }));
    await assert.rejects(
      legacy.issuer(f.issuer.issuerId),
      /ISSUER_NOT_TRUSTED/,
    );
    await legacy.bind(
      { ...f.issuer, keys: [key] },
      "https://control.test",
      key.fingerprint,
    );
    await assert.rejects(
      legacy.bind(
        {
          issuerId: "renamed",
          revision: 999,
          keys: [{ ...f.issuer.keys[0]!, keyId: "alias" }],
        },
        "https://control.test",
        f.issuer.keys[0]!.fingerprint,
      ),
      /ISSUER_KEY_REVOKED/,
    );
    assert.deepEqual((await legacy.issuer(f.issuer.issuerId)).keys, [key]);
  } finally {
    await f.close();
  }
});
