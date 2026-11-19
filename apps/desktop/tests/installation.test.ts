import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseDesktopRelease, type DesktopRelease } from "../src/installation/release.ts";
import { requireMacDesktopIdentity } from "../src/installation/host-identity.ts";
import { verifyUpdateEnvelope, type DesktopUpdate } from "../src/main/update.ts";
import { desktopInventory } from "../scripts/desktop-inventory.mjs";

/**
 * 每个用例生成仅供合成签名验证的临时发布者密钥与版本关系，不读取操作系统保险库或使用生产证书；fixture 只描述当前应用的
 * 本地信任输入，绝不冒充真实签名安装、Mac 目标或可发布候选已经验收。
 */
function fixture() {
    const keys = generateKeyPairSync("ed25519");
    const release: DesktopRelease = {
        schemaVersion: 1,
        appId: "io.github.baofengbaofeng.veriq",
        productName: "VeriQ",
        candidate: "unit-candidate",
        sourceCommit: "a".repeat(40),
        platform: "linux",
        arch: "x64",
        productVersion: "1.0.0",
        signing: { mode: "DEVELOPMENT_UNSIGNED" },
        guiInventorySha256: "b".repeat(64),
        profileFormat: 2,
        updatePublicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
        trustedRuntime: {
            arch: "x64",
            manifestSha256: "c".repeat(64),
            productVersion: "1.0.0",
            nodeVersion: "24.22.1",
            engineVersion: "1.0.3",
        },
    };
    const update: DesktopUpdate = {
        schemaVersion: 1,
        appId: release.appId,
        platform: "linux",
        arch: "x64",
        version: "1.1.0",
        direction: "upgrade",
        fromVersions: ["1.0.0"],
        compatibleEngineVersions: ["1.0.3"],
        runtimeEngineVersion: "1.0.3",
        profileFormat: 2,
        installer: {
            name: "VeriQ-1.1.0-linux-x64.deb",
            sha256: "d".repeat(64),
            sizeBytes: 32,
            nativeSigner: "DETACHED_ED25519",
        },
    };
    const envelope = (value = update) => {
        const payload = Buffer.from(JSON.stringify(value));
        return Buffer.from(
            JSON.stringify({
                payload: payload.toString("base64"),
                signature: sign(null, payload, keys.privateKey).toString("base64"),
            }),
        );
    };
    return { release, update, envelope };
}

/**
 * 发布者签名只能认证精确安装器与当前来源版本，测试同时观察正常升级和明确兼容的回滚；回滚方向不是跳过版本或格式检查的万
 * 能开关，同版本重放、旧格式与缺少当前引擎支持都必须拒绝。
 */
test("signed update requires exact target, origin version, profile and engine compatibility", () => {
    const { release, update, envelope } = fixture();
    assert.deepEqual(verifyUpdateEnvelope(envelope(), release), update);
    assert.equal(
        verifyUpdateEnvelope(envelope({ ...update, version: "0.9.0", direction: "rollback" }), release).direction,
        "rollback",
    );
    for (const changed of [
        { ...update, version: release.productVersion },
        { ...update, arch: "arm64" as const },
        { ...update, fromVersions: ["0.9.0"] },
        { ...update, compatibleEngineVersions: ["0.0.0"] },
        { ...update, runtimeEngineVersion: "2.0.0" },
        { ...update, profileFormat: 3 },
        { ...update, installer: { ...update.installer, name: "../other.deb" } },
    ])
        assert.throws(
            () => verifyUpdateEnvelope(envelope(changed as DesktopUpdate), release),
            /DESKTOP_UPDATE_MANIFEST_INVALID/,
        );
});

/**
 * 合法正文和另一发布者签名、字节篡改以及本机缺少更新公钥不能获得同一更新权限，测试使用真实标准签名算法而不替换验签结果
 * ；失败在解释安装文件路径和请求维护停止之前发生，业务执行不受影响。
 */
test("update rejects altered payload, unknown publisher and missing trust root", () => {
    const first = fixture(),
        second = fixture();
    assert.throws(() => verifyUpdateEnvelope(first.envelope(), second.release), /DESKTOP_UPDATE_SIGNATURE_INVALID/);
    const altered = JSON.parse(first.envelope().toString());
    altered.payload = Buffer.from(JSON.stringify({ ...first.update, version: "9.9.9" })).toString("base64");
    assert.throws(
        () => verifyUpdateEnvelope(Buffer.from(JSON.stringify(altered)), first.release),
        /DESKTOP_UPDATE_SIGNATURE_INVALID/,
    );
    const { updatePublicKeyPem: _key, ...withoutKey } = first.release;
    assert.throws(() => verifyUpdateEnvelope(first.envelope(), withoutKey), /DESKTOP_UPDATE_KEY_UNCONFIGURED/);
});

/**
 * 桌面身份必须固定 Bundle ID 与四种架构组合，Mac Cookie 能力更要求同进程真实宿主核验的私有品牌；结构相同、冻结或复制的
 * 对象都无法通过这个边界，测试不授予合成 Mac 实际 Keychain 操作权限。
 */
test("desktop release identities and Mac host capabilities fail closed", () => {
    const { release } = fixture();
    assert.equal(parseDesktopRelease(release), release);
    for (const change of [
        { appId: "other.application" },
        { arch: "arm64" },
        { platform: "darwin" },
        { profileFormat: 3 },
        { trustedRuntime: { ...release.trustedRuntime, productVersion: "9.0.0" } },
    ])
        assert.throws(() => parseDesktopRelease({ ...release, ...change }), /DESKTOP_RELEASE_INVALID/);
    for (const value of [undefined, true, {}, Object.freeze({ platform: "darwin" })])
        assert.throws(() => requireMacDesktopIdentity(value), /COOKIE_MAC_HOST_IDENTITY_REQUIRED/);
});

/**
 * GUI 字节库存覆盖真实生成入口与本地 renderer 资源，新增文件改变独立摘要而链接不能进入候选；测试创建临时普通文件并核对
 * 可观察结果，不通过扫描源码关键字或假造打包回执证明安装器可用。
 */
test("GUI inventory covers all resources and refuses linked input", async () => {
    const directory = await mkdtemp(join(tmpdir(), "veriq-gui-inventory-"));
    try {
        for (const part of ["main", "preload", "renderer"]) await mkdir(join(directory, part));
        for (const file of [
            "main/index.js",
            "main/agent.js",
            "main/cli.js",
            "preload/index.cjs",
            "renderer/index.html",
            "LICENSE",
            "THIRD_PARTY_NOTICES.md",
        ])
            await writeFile(join(directory, file), "local-resource");
        const first = await desktopInventory(directory);
        await writeFile(join(directory, "renderer/worker.js"), "local-worker");
        const second = await desktopInventory(directory);
        assert.notEqual(first.sha256, second.sha256);
        assert.equal(second.files.length, first.files.length + 1);
        await symlink(join(directory, "renderer/worker.js"), join(directory, "renderer/link.js"));
        await assert.rejects(desktopInventory(directory), /DESKTOP_GUI_LINK_FORBIDDEN/);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
