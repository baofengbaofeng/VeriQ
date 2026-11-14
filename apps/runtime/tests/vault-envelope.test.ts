/** 凭据封装测试只使用内存中的合成密钥与载荷，通过真实标准加密核验认证绑定、大小边界及失败信息；不把独立算法测试描述为系统保险库或安装环境的持久化验收。 */
import assert from "node:assert/strict";
import { createCipheriv, randomBytes } from "node:crypto";
import { test } from "node:test";
import { canonicalBytes, type JsonValue } from "@veriq/contracts";
import {
    openEnvelope,
    sealEnvelope,
    VaultError,
    type EnvelopeBinding,
} from "../src/credentials/envelope.ts";

const profileId = "11111111-1111-4111-8111-111111111111";
const keyVersion = "22222222-2222-4222-8222-222222222222";
const workspaceId = "33333333-3333-4333-8333-333333333333";
const versionId = "44444444-4444-4444-8444-444444444444";
const otherId = "55555555-5555-4555-8555-555555555555";
const binding: EnvelopeBinding = {
    profileId,
    keyVersion,
    purpose: "business",
    reference: { issuerId: "issuer_one", workspaceId, secretRef: "login", versionId },
};
const key = randomBytes(32);
const secret = "synthetic-secret-credential-value";

function failure(operation: () => unknown, code?: string) {
    assert.throws(operation, (error: unknown) => {
        assert(error instanceof VaultError);
        if (code) assert.equal(error.code, code);
        assert.equal(error.message, error.code);
        assert.equal(error.cause, undefined);
        const diagnostic = `${error.stack} ${JSON.stringify(error)}`;
        for (const forbidden of [secret, key.toString("hex"), key.toString("base64url")])
            assert(!diagnostic.includes(forbidden));
        return true;
    });
}

test("real AES-GCM round trips JSON values without returning key or plaintext", () => {
    const values: JsonValue[] = [
        null,
        true,
        123.5,
        "中文😀",
        [1, false],
        { secret, nested: [null] },
    ];
    for (const value of values) {
        const wire = sealEnvelope(value, binding, key);
        assert.deepEqual(openEnvelope(wire, binding, key), value);
        assert(!wire.includes(secret));
        assert(!wire.includes(key.toString("base64url")));
    }
});

test("same payload receives a fresh nonce and ciphertext on each seal", () => {
    const first = JSON.parse(sealEnvelope(secret, binding, key));
    const second = JSON.parse(sealEnvelope(secret, binding, key));
    assert.notEqual(first.iv, second.iv);
    assert.notEqual(first.ciphertext, second.ciphertext);
    assert.equal(Buffer.from(first.iv, "base64url").length, 12);
    assert.equal(Buffer.from(first.tag, "base64url").length, 16);
});

test("exact one MiB UTF8 JSON payload survives envelope overhead; excess is rejected", () => {
    const value = "é".repeat((1024 * 1024 - 2) / 2);
    assert.equal(Buffer.byteLength(JSON.stringify(value)), 1024 * 1024);
    const wire = sealEnvelope(value, binding, key);
    assert(Buffer.byteLength(wire) > 1024 * 1024);
    assert(Buffer.byteLength(wire) <= 2 * 1024 * 1024);
    assert.equal(openEnvelope(wire, binding, key), value);
    failure(() => sealEnvelope(value + "x", binding, key), "VAULT_PAYLOAD_LIMIT");
    failure(
        () => openEnvelope(" ".repeat(2 * 1024 * 1024 + 1), binding, key),
        "VAULT_ENVELOPE_LIMIT",
    );
});

test("device and rotation bind the complete principal, generation and request identity", () => {
    const reference = {
        server: "https://control.example",
        workspaceId,
        runnerId: versionId,
        generation: otherId,
    };
    const device: EnvelopeBinding = { profileId, keyVersion, purpose: "device", reference };
    const rotation: EnvelopeBinding = {
        profileId,
        keyVersion,
        purpose: "rotation",
        reference: { ...reference, clientRequestId: profileId },
    };
    for (const context of [device, rotation]) {
        const wire = sealEnvelope({ secret }, context, key);
        assert.deepEqual(openEnvelope(wire, context, key), { secret });
        for (const field of Object.keys(context.reference)) {
            const changed = structuredClone(context);
            (changed.reference as unknown as Record<string, string>)[field] =
                field === "server" ? "https://other.example" : keyVersion;
            failure(() => openEnvelope(wire, changed, key), "VAULT_BINDING_MISMATCH");
        }
    }
    failure(
        () => openEnvelope(sealEnvelope(secret, device, key), rotation, key),
        "VAULT_BINDING_MISMATCH",
    );
});

test("every business identity component and key version is supplied independently by caller", () => {
    const wire = sealEnvelope(secret, binding, key);
    const alternatives = [
        { ...binding, profileId: otherId },
        { ...binding, keyVersion: otherId },
        ...Object.keys(binding.reference).map((field) => ({
            ...binding,
            reference: {
                ...binding.reference,
                [field]: ["workspaceId", "versionId"].includes(field) ? otherId : "other",
            },
        })),
    ];
    for (const changed of alternatives) {
        failure(
            () => openEnvelope(wire, changed as EnvelopeBinding, key),
            "VAULT_BINDING_MISMATCH",
        );
        const rewritten = JSON.parse(wire);
        rewritten.binding = changed;
        failure(
            () => openEnvelope(JSON.stringify(rewritten), changed as EnvelopeBinding, key),
            "VAULT_AUTHENTICATION_FAILED",
        );
    }
});

test("authenticated non-JSON and invalid UTF8 are refused without returning plaintext", () => {
    for (const bytes of [
        Buffer.from("not-json:" + secret),
        Buffer.from([0x22, 0xff, 0x22]),
        Buffer.from('"\\ud800"'),
    ]) {
        const iv = randomBytes(12);
        const metadata = { version: 1, algorithm: "AES-256-GCM", binding };
        const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
        cipher.setAAD(canonicalBytes(metadata));
        const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
        const wire = JSON.stringify({
            ...metadata,
            iv: iv.toString("base64url"),
            tag: cipher.getAuthTag().toString("base64url"),
            ciphertext: ciphertext.toString("base64url"),
        });
        failure(() => openEnvelope(wire, binding, key), "VAULT_INVALID_PAYLOAD");
    }
});

test("ciphertext, IV, tag and authenticated metadata modifications cannot decrypt", () => {
    const wire = sealEnvelope(secret, binding, key);
    for (const field of ["ciphertext", "iv", "tag"]) {
        const envelope = JSON.parse(wire);
        const bytes = Buffer.from(envelope[field], "base64url");
        bytes[0] = bytes[0]! ^ 1;
        envelope[field] = bytes.toString("base64url");
        failure(
            () => openEnvelope(JSON.stringify(envelope), binding, key),
            "VAULT_AUTHENTICATION_FAILED",
        );
    }
    const envelope = JSON.parse(wire);
    envelope.binding.profileId = otherId;
    const changed = { ...binding, profileId: otherId };
    failure(
        () => openEnvelope(JSON.stringify(envelope), changed, key),
        "VAULT_AUTHENTICATION_FAILED",
    );
    failure(() => openEnvelope(wire, binding, randomBytes(32)), "VAULT_AUTHENTICATION_FAILED");
});

test("unknown format, algorithm, fields, malformed JSON and oversized envelopes fail closed", () => {
    const original = JSON.parse(sealEnvelope(secret, binding, key));
    for (const mutation of [
        { ...original, version: 2 },
        { ...original, algorithm: "aes-128-gcm" },
        { ...original, unexpected: secret },
        { ...original, ciphertext: 1 },
        { ...original, binding: { ...original.binding, extra: true } },
    ])
        failure(
            () => openEnvelope(JSON.stringify(mutation), binding, key),
            "VAULT_INVALID_ENVELOPE",
        );
    for (const wire of ["{", "null", "[]", "true"])
        failure(() => openEnvelope(wire, binding, key), "VAULT_INVALID_ENVELOPE");
});

test("noncanonical base64url and incorrect encoded lengths are rejected before crypto", () => {
    const original = JSON.parse(sealEnvelope(secret, binding, key));
    for (const field of ["iv", "tag", "ciphertext"]) {
        for (const value of [original[field] + "=", "+++///", "", "a", original[field] + "\n"])
            failure(
                () => openEnvelope(JSON.stringify({ ...original, [field]: value }), binding, key),
                "VAULT_INVALID_ENVELOPE",
            );
    }
    for (const [field, length] of [
        ["iv", 11],
        ["iv", 13],
        ["tag", 15],
        ["tag", 17],
    ] as const)
        failure(
            () =>
                openEnvelope(
                    JSON.stringify({
                        ...original,
                        [field]: randomBytes(length).toString("base64url"),
                    }),
                    binding,
                    key,
                ),
            "VAULT_INVALID_ENVELOPE",
        );
    failure(
        () =>
            openEnvelope(
                JSON.stringify({
                    ...original,
                    ciphertext: Buffer.alloc(1024 * 1024 + 1).toString("base64url"),
                }),
                binding,
                key,
            ),
        "VAULT_PAYLOAD_LIMIT",
    );
});

test("invalid keys, bindings and nonportable JSON produce only stable safe errors", () => {
    for (const length of [0, 31, 33]) {
        failure(() => sealEnvelope(secret, binding, randomBytes(length)), "VAULT_INVALID_KEY");
        failure(
            () => openEnvelope(sealEnvelope(secret, binding, key), binding, randomBytes(length)),
            "VAULT_INVALID_KEY",
        );
    }
    for (const value of [undefined, NaN, { secret, bad: undefined }, "\ud800"])
        failure(() => sealEnvelope(value as JsonValue, binding, key), "VAULT_INVALID_PAYLOAD");
    for (const context of [
        { ...binding, profileId: "" },
        { ...binding, purpose: "latest" },
        { ...binding, reference: { ...binding.reference, versionId: "latest" } },
    ])
        failure(
            () => sealEnvelope(secret, context as EnvelopeBinding, key),
            "VAULT_INVALID_BINDING",
        );
});
