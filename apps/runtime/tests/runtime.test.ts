import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { spawn } from "node:child_process";

const moduleUrl = new URL("../src/enrollment.ts", import.meta.url);
test("native enrollment client persists a private credential and logout revokes it", async () => {
  const { RuntimeClient, DeviceStore } = await import(moduleUrl.href);
  const directory = await mkdtemp(join(tmpdir(), "veriq-runtime-"));
  let revoked = false;
  const server = createServer((req, res) => {
    assert.equal(req.headers.cookie, undefined);
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/internal/v1/runtime/logout") {
      assert.equal(req.headers.authorization, "Bearer synthetic-test-token");
      revoked = true;
      res.end(JSON.stringify({ data: {}, requestId: "test" }));
    } else
      res.end(
        JSON.stringify({
          data: {
            runnerId: "11111111-1111-4111-8111-111111111111",
            workspaceId: "22222222-2222-4222-8222-222222222222",
            deviceToken: "synthetic-test-token",
            expiresAt: "2026-12-01T00:00:00Z",
          },
          requestId: "test",
        }),
      );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    const store = new DeviceStore(directory);
    const client = new RuntimeClient(origin);
    const receipt = await client.poll("device-secret");
    await store.save({ server: origin, ...receipt });
    const saved = await store.load();
    assert.equal(saved.deviceToken, "synthetic-test-token");
    assert.equal(
      (await stat(join(directory, "device.json"))).mode & 0o777,
      0o600,
    );
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    await client.logout(saved.deviceToken);
    await store.remove();
    assert(revoked);
    await assert.rejects(store.load());
  } finally {
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("client rejects unsafe control origins, redirects and redacts error response secrets", async () => {
  const { RuntimeClient } = await import(moduleUrl.href);
  for (const origin of [
    "http://example.com",
    "https://user:secret@example.com",
    "https://example.com/path",
    "https://example.com/?token=secret",
  ])
    assert.throws(() => new RuntimeClient(origin));
  const server = createServer((_req, res) => {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        code: "DEVICE_UNAUTHORIZED",
        message: "synthetic-secret-should-not-leak",
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const a = server.address();
    assert(a && typeof a !== "string");
    await assert.rejects(
      new RuntimeClient(`http://127.0.0.1:${a.port}`).poll("secret"),
      (e: Error) =>
        !e.message.includes("synthetic-secret") &&
        e.message.includes("DEVICE_UNAUTHORIZED"),
    );
  } finally {
    server.close();
  }
});

test("doctor launches a real browser and checks a real network endpoint; missing executable fails", async () => {
  const { doctor } = await import(
    new URL("../src/doctor.ts", import.meta.url).href
  );
  const server = createServer((_req, res) => {
    res.end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const a = server.address();
    assert(a && typeof a !== "string");
    const good = await doctor({
      server: `http://127.0.0.1:${a.port}`,
      executablePath: process.env.VERIQ_TEST_CHROMIUM,
    });
    assert.equal(good.ok, true, JSON.stringify(good));
    assert(
      good.checks.some(
        (c: { name: string; ok: boolean }) =>
          c.name === "browser launch" && c.ok,
      ),
    );
    const bad = await doctor({
      server: `http://127.0.0.1:${a.port}`,
      executablePath: "/nonexistent/veriq-browser",
    });
    assert.equal(bad.ok, false);
  } finally {
    server.close();
  }
});

test("CLI help exposes implemented commands and doctor returns a nonzero failure exit", async () => {
  const run = (args: string[]) =>
    new Promise<{ status: number | null; output: string }>((resolve) => {
      const p = spawn(
        process.execPath,
        ["--import", "tsx", "src/cli.ts", ...args],
        {
          cwd: new URL("..", import.meta.url),
          env: { ...process.env, FORCE_COLOR: "0" },
        },
      );
      let output = "";
      p.stdout.on("data", (d) => (output += d));
      p.stderr.on("data", (d) => (output += d));
      p.on("close", (status) => resolve({ status, output }));
    });
  const help = await run(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.output, /login/);
  assert.match(help.output, /doctor/);
  const failed = await run([
    "doctor",
    "--browser-executable",
    "/missing-browser",
  ]);
  assert.equal(failed.status, 1);
  assert.match(failed.output, /browser/);
});

test("client rejects malformed enrollment and credential responses before storage", async () => {
  const { RuntimeClient } = await import(moduleUrl.href);
  const server = createServer((_req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        data: { deviceToken: "secret", server: "https://attacker.invalid" },
        requestId: "test",
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const a = server.address();
    assert(a && typeof a !== "string");
    await assert.rejects(
      new RuntimeClient(`http://127.0.0.1:${a.port}`).poll("secret"),
      /INVALID_RESPONSE/,
    );
  } finally {
    server.close();
  }
});

test("a second enrollment never overwrites the existing device credential", async () => {
  const { DeviceStore } = await import(moduleUrl.href);
  const directory = await mkdtemp(join(tmpdir(), "veriq-existing-device-"));
  const config = {
    server: "http://127.0.0.1:1",
    runnerId: "11111111-1111-4111-8111-111111111111",
    workspaceId: "22222222-2222-4222-8222-222222222222",
    deviceToken: "synthetic-existing-token",
    expiresAt: "2026-12-01T00:00:00Z",
  };
  const store = new DeviceStore(directory);
  try {
    await store.save(config);
    await assert.rejects(
      store.save({ ...config, deviceToken: "synthetic-replacement" }),
      /ALREADY_ENROLLED/,
    );
    assert.equal((await store.load()).deviceToken, config.deviceToken);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function recoveryCli(directory: string, args: string[], input = "") {
  return new Promise<{ status: number | null; output: string }>(
    (resolve, reject) => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "src/cli.ts", "--config-dir", directory, ...args],
        {
          cwd: new URL("..", import.meta.url),
        },
      );
      let output = "";
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("CLI recovery test timed out"));
      }, 20_000);
      child.stdout.on("data", (chunk) => (output += String(chunk)));
      child.stderr.on("data", (chunk) => (output += String(chunk)));
      child.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.on("close", (status) => {
        clearTimeout(timeout);
        resolve({ status, output });
      });
      child.stdin.end(input);
    },
  );
}

const recoveryReceipt = {
  runnerId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  deviceToken: "synthetic-private-recovery-token",
  expiresAt: "2020-01-01T00:00:00Z",
};

for (const code of ["DEVICE_UNAUTHORIZED", "DEVICE_REVOKED"]) {
  test(`logout recovery clears definitive ${code} and permits CLI enrollment in the same directory`, async () => {
    const { DeviceStore } = await import(moduleUrl.href);
    const directory = await mkdtemp(join(tmpdir(), "veriq-logout-recovery-"));
    const nextReceipt = {
      ...recoveryReceipt,
      runnerId: "33333333-3333-4333-8333-333333333333",
      deviceToken: "synthetic-replacement-device-token",
      expiresAt: "2099-01-01T00:00:00Z",
    };
    const bootstrap = "B".repeat(43);
    let logoutCalls = 0,
      enrolled = 0;
    const server = createServer((req, res) => {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/internal/v1/runtime/logout") {
        logoutCalls++;
        assert.equal(
          req.headers.authorization,
          "Bearer " + recoveryReceipt.deviceToken,
        );
        res.writeHead(401);
        res.end(JSON.stringify({ code, message: recoveryReceipt.deviceToken }));
      } else if (req.url === "/api/v1/health/live") {
        res.end(JSON.stringify({ data: { alive: true } }));
      } else if (req.url === "/internal/v1/runtime-enrollments/service") {
        enrolled++;
        assert.equal(req.headers.authorization, "Bearer " + bootstrap);
        res.writeHead(201);
        res.end(JSON.stringify({ data: nextReceipt }));
      } else {
        res.writeHead(404);
        res.end("{}");
      }
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const address = server.address();
      assert(address && typeof address !== "string");
      const origin = `http://127.0.0.1:${address.port}`;
      const store = new DeviceStore(directory);
      await store.save({ server: origin, ...recoveryReceipt });
      const logout = await recoveryCli(directory, ["logout"]);
      assert.equal(logout.status, 0, logout.output);
      assert.match(logout.output, /already invalid|already rejected/);
      assert.doesNotMatch(logout.output, /Device credential revoked/);
      assert(!logout.output.includes(recoveryReceipt.deviceToken));
      await assert.rejects(store.load(), { code: "ENOENT" });
      const reenroll = await recoveryCli(
        directory,
        [
          "enroll-service",
          "--server",
          origin,
          "--name",
          "Recovered device",
          ...(process.env.VERIQ_TEST_CHROMIUM
            ? ["--browser-executable", process.env.VERIQ_TEST_CHROMIUM]
            : []),
        ],
        bootstrap,
      );
      assert.equal(reenroll.status, 0, reenroll.output);
      assert.equal((await store.load()).deviceToken, nextReceipt.deviceToken);
      assert.equal(logoutCalls, 1);
      assert.equal(enrolled, 1);
      assert(!reenroll.output.includes(bootstrap));
      assert(!reenroll.output.includes(nextReceipt.deviceToken));
      for (const command of ["login", "enroll-service"]) {
        const repeat = await recoveryCli(directory, [
          command,
          "--server",
          origin,
        ]);
        assert.equal(repeat.status, 1);
        assert.match(repeat.output, /ALREADY_ENROLLED/);
        assert.equal((await store.load()).deviceToken, nextReceipt.deviceToken);
      }
      assert.equal(enrolled, 1);
    } finally {
      server.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("logout recovery retains credentials on transport and non-definitive HTTP failures", async () => {
  const { DeviceStore } = await import(moduleUrl.href);
  const directory = await mkdtemp(join(tmpdir(), "veriq-logout-network-"));
  let mode = "transport";
  const server = createServer((req, res) => {
    if (mode === "transport") {
      req.socket.destroy();
      return;
    }
    res.writeHead(mode === "unknown" ? 401 : 503, {
      "Content-Type": "application/json",
    });
    res.end(
      JSON.stringify({
        code:
          mode === "unknown"
            ? "AUTHENTICATION_REQUIRED"
            : "DEVICE_UNAUTHORIZED",
        message: recoveryReceipt.deviceToken,
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert(address && typeof address !== "string");
    const store = new DeviceStore(directory);
    await store.save({
      server: `http://127.0.0.1:${address.port}`,
      ...recoveryReceipt,
    });
    for (mode of ["transport", "unknown", "unavailable"]) {
      const result = await recoveryCli(directory, ["logout"]);
      assert.equal(result.status, 1);
      assert.equal(
        (await store.load()).deviceToken,
        recoveryReceipt.deviceToken,
      );
      assert(!result.output.includes(recoveryReceipt.deviceToken));
      assert.doesNotMatch(
        result.output,
        /credential revoked|configuration removed/,
      );
    }
  } finally {
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("logout recovery local-only clears just credentials without contacting the unreachable server", async () => {
  const { DeviceStore } = await import(moduleUrl.href);
  const { writeFile } = await import("node:fs/promises");
  const directory = await mkdtemp(join(tmpdir(), "veriq-logout-local-"));
  let requests = 0;
  const server = createServer((req) => {
    requests++;
    req.socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert(address && typeof address !== "string");
    const store = new DeviceStore(directory);
    await store.save({
      server: `http://127.0.0.1:${address.port}`,
      ...recoveryReceipt,
    });
    await writeFile(join(directory, "project.json"), "project assets");
    await writeFile(join(directory, "results.json"), "execution results");
    const result = await recoveryCli(directory, ["logout", "--local-only"]);
    assert.equal(result.status, 0, result.output);
    assert.equal(requests, 0);
    assert.match(result.output, /Local device credential removed/);
    assert.match(result.output, /Remote revocation was not attempted/);
    assert.match(result.output, /Web.*revok|revok.*Web/);
    assert.match(result.output, /expir/);
    assert(!result.output.includes(recoveryReceipt.deviceToken));
    await assert.rejects(store.load(), { code: "ENOENT" });
    assert.equal(
      await readFile(join(directory, "project.json"), "utf8"),
      "project assets",
    );
    assert.equal(
      await readFile(join(directory, "results.json"), "utf8"),
      "execution results",
    );
  } finally {
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
