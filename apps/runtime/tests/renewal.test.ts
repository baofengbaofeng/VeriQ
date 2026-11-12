import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DeviceStore, RuntimeClient } from "../src/enrollment.ts";
test("lost renewal response recovers exact private candidate and atomically preserves device identity", async () => {
    const directory = await mkdtemp(join(tmpdir(), "veriq-t10-renew-"));
    let first = true;
    let pending:
        | {
              clientRequestId: string;
              replacementToken: string;
          }
        | undefined;
    const server = createServer(async (req, res) => {
        let body = "";
        for await (const chunk of req) body += chunk;
        const value = JSON.parse(body);
        if (pending) assert.deepEqual(value, pending);
        else pending = value;
        assert.equal(req.headers.authorization, "Bearer " + "o".repeat(43));
        if (first) {
            first = false;
            req.socket.destroy();
            return;
        }
        res.end(
            JSON.stringify({
                data: {
                    runnerId: "11111111-1111-4111-8111-111111111111",
                    workspaceId: "22222222-2222-4222-8222-222222222222",
                    deviceToken: value.replacementToken,
                    expiresAt: "2026-12-01T00:00:00Z",
                },
            }),
        );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
        const address = server.address();
        assert(address && typeof address !== "string");
        const origin = `http://127.0.0.1:${address.port}`;
        const store = new DeviceStore(directory);
        await store.save({
            server: origin,
            runnerId: "11111111-1111-4111-8111-111111111111",
            workspaceId: "22222222-2222-4222-8222-222222222222",
            deviceToken: "o".repeat(43),
            expiresAt: "2026-12-01T00:00:00Z",
        });
        assert.equal(
            typeof store.renew,
            "function",
            "renewal must be recoverable across a lost HTTP reply",
        );
        await assert.rejects(store.renew(new RuntimeClient(origin)), /NETWORK_UNAVAILABLE/);
        assert.equal((await store.load()).deviceToken, "o".repeat(43));
        assert.equal((await stat(join(directory, "rotation.json"))).mode & 0o777, 0o600);
        const recovered = await new DeviceStore(directory).renew(new RuntimeClient(origin));
        assert.equal(recovered.deviceToken, pending!.replacementToken);
        assert.equal((await store.load()).deviceToken, recovered.deviceToken);
        await assert.rejects(readFile(join(directory, "rotation.json")), { code: "ENOENT" });
    } finally {
        server.closeAllConnections();
        server.close();
        await rm(directory, { recursive: true, force: true });
    }
});
test("local logout removes a pending candidate and cannot resurrect it over a new enrollment", async () => {
    const directory = await mkdtemp(join(tmpdir(), "veriq-t10-forget-"));
    const { writeFile } = await import("node:fs/promises");
    const store = new DeviceStore(directory);
    const config = {
        server: "http://127.0.0.1:1",
        runnerId: "11111111-1111-4111-8111-111111111111",
        workspaceId: "22222222-2222-4222-8222-222222222222",
        deviceToken: "o".repeat(43),
        expiresAt: "2026-12-01T00:00:00Z",
    };
    try {
        await store.save(config);
        await writeFile(
            join(directory, "rotation.json"),
            JSON.stringify({
                previous: config,
                clientRequestId: "33333333-3333-4333-8333-333333333333",
                replacementToken: "x".repeat(43),
            }),
            { mode: 0o600 },
        );
        await store.remove();
        assert.equal(await store.hasPendingRotation(), false);
        await assert.rejects(store.load(), { code: "ENOENT" });
        await store.save({ ...config, runnerId: "44444444-4444-4444-8444-444444444444" });
        assert.equal(await store.hasPendingRotation(), false);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("an active Agent blocks concurrent profile ownership and local logout without breaking renewal locks", async () => {
    const { DeviceSession } = await import("../src/agent/credentials.ts");
    const directory = await mkdtemp(join(tmpdir(), "veriq-t10-owner-"));
    const server = createServer(async (req, res) => {
        let body = "";
        for await (const part of req) body += part;
        const candidate = JSON.parse(body).replacementToken;
        res.end(
            JSON.stringify({
                data: {
                    runnerId: "11111111-1111-4111-8111-111111111111",
                    workspaceId: "22222222-2222-4222-8222-222222222222",
                    deviceToken: candidate,
                    expiresAt: "2027-01-01T00:00:00Z",
                },
            }),
        );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    let session: InstanceType<typeof DeviceSession> | undefined;
    try {
        const a = server.address();
        assert(a && typeof a !== "string");
        const origin = `http://127.0.0.1:${a.port}`,
            store = new DeviceStore(directory);
        await store.save({
            server: origin,
            runnerId: "11111111-1111-4111-8111-111111111111",
            workspaceId: "22222222-2222-4222-8222-222222222222",
            deviceToken: "a".repeat(43),
            expiresAt: "2027-01-01T00:00:00Z",
        });
        session = new DeviceSession(store, new RuntimeClient(origin));
        await session.open();
        await assert.rejects(new DeviceSession(store, new RuntimeClient(origin)).open(), {
            code: "ELOCKED",
        });
        await assert.rejects(store.remove(), /AGENT_RUNNING_STOP_FIRST/);
        await session.close();
        session = undefined;
        await store.remove();
    } finally {
        await session?.close();
        server.closeAllConnections();
        server.close();
        await rm(directory, { recursive: true, force: true });
    }
});

test("recovery after atomic profile replacement only clears its journal and stale identity cannot overwrite new enrollment", async () => {
    const { writeFile } = await import("node:fs/promises");
    const directory = await mkdtemp(join(tmpdir(), "veriq-t10-renew-window-")),
        store = new DeviceStore(directory);
    const previous = {
        server: "http://127.0.0.1:1",
        runnerId: "11111111-1111-4111-8111-111111111111",
        workspaceId: "22222222-2222-4222-8222-222222222222",
        deviceToken: "a".repeat(43),
        expiresAt: "2027-01-01T00:00:00Z",
    };
    const pending = {
        previous,
        clientRequestId: "33333333-3333-4333-8333-333333333333",
        replacementToken: "b".repeat(43),
    };
    try {
        await store.save({ ...previous, deviceToken: pending.replacementToken });
        await writeFile(join(directory, "rotation.json"), JSON.stringify(pending), { mode: 0o600 });
        // No server is listening: committed local recovery must not attempt another rotation.
        assert.equal(
            (await store.renew(new RuntimeClient(previous.server))).deviceToken,
            pending.replacementToken,
        );
        assert.equal(await store.hasPendingRotation(), false);
        await store.remove();
        const next = {
            ...previous,
            runnerId: "44444444-4444-4444-8444-444444444444",
            deviceToken: "c".repeat(43),
        };
        await store.save(next);
        await writeFile(join(directory, "rotation.json"), JSON.stringify(pending), { mode: 0o600 });
        await assert.rejects(
            store.renew(new RuntimeClient(previous.server)),
            /DEVICE_PRINCIPAL_CHANGED/,
        );
        assert.deepEqual(await store.load(), next);
        await store.remove();
        assert.equal(await store.hasPendingRotation(), false);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
