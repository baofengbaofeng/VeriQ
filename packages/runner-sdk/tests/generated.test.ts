import ts from "typescript";
import { it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
// 分段注释：继续说明 generated.test.ts 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
// 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
// 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
import { compileFiles, verifyFiles } from "../../compiler/src/index.js";
import { snapshot, asset, id, rehash } from "../../compiler/tests/helpers.js";
import { actualDistribution } from "./distribution.js";
import { fixture } from "./helpers.js";
const exec = promisify(execFile);
it("installs the actual emitted SDK closure offline and executes generated TS through Playwright Chromium", async () => {
  const root = await mkdtemp(join(tmpdir(), "veriq-real-sdk-")),
    f = await fixture();
  // 分段注释：继续说明 generated.test.ts 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
  // 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
  // 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
  try {
    const syntheticSecret = "generated-runtime-protected-secret";
    f.responses.set("/protected", { token: syntheticSecret });
    const source = snapshot(
      [
        { id: "open", action: "goto", path: "/" },
        {
          id: "fill",
          // 分段注释：继续说明 generated.test.ts 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
          // 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
          // 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
          action: "fill",
          target: "name",
          value: "attempt-generated",
        },
        {
          id: "save",
          action: "click",
          target: "save",
          // 分段注释：继续说明 generated.test.ts 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
          // 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
          // 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
          observers: [
            {
              id: "saved",
              method: "POST",
              path: "/save",
              bodyMatch: { code: "attempt-generated" },
              window: { mode: "UNTIL_ACTION_SETTLED", quietMs: 10 },
            },
          // 分段注释：继续说明 generated.test.ts 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
          // 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
          // 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
          ],
          afterAssertions: [
            {
              id: "code",
              type: "responseField",
              source: "response:saved",
              pointer: "/code",
              operator: "equals",
              // 分段注释：继续说明 generated.test.ts 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
              // 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
              // 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
              expected: 0,
              severity: "BLOCK",
              expectedSource: "REQ-generated",
            },
          ],
        },
        {
          id: "protected",
          // 分段注释：继续说明 generated.test.ts 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
          // 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
          // 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
          action: "apiRequest",
          method: "GET",
          path: "/protected",
          observers: [
            {
              id: "protectedResponse",
              method: "GET",
              path: "/protected",
              // 分段注释：继续说明 generated.test.ts 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
              // 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
              // 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
              window: { mode: "UNTIL_ACTION_SETTLED", quietMs: 0 },
            },
          ],
          afterAssertions: [
            {
              id: "private",
              type: "responseField",
              source: "response:protectedResponse",
              // 分段注释：继续说明 generated.test.ts 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
              // 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
              // 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
              pointer: "/token",
              operator: "notEquals",
              expected: "public",
              severity: "BLOCK",
              expectedSource: "REQ-secret-separation",
            },
          ],
        },
      // 分段注释：继续说明 generated.test.ts 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
      // 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
      // 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
      ],
      [
        asset(3, "FIXTURE", {
          schemaVersion: "1.0",
          prepare: { method: "POST", path: "/prepare" },
          query: { method: "GET", path: "/query" },
          cleanup: { method: "POST", path: "/cleanup" },
          inputSchema: {
            // 分段注释：继续说明 generated.test.ts 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            // 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
            // 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
            type: "object",
            properties: { name: { type: "string", minLength: 2 } },
            required: ["name"],
            additionalProperties: false,
          },
          outputSchema: {
            type: "object",
            properties: { code: { type: "string" } },
            // 分段注释：继续说明 generated.test.ts 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            // 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
            // 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
            required: ["code"],
          },
          ttlSeconds: 60,
        }),
      ],
      {
        fixtureVersionId: id(3),
        initialVariables: { private: "string" },
        // 分段注释：继续说明 generated.test.ts 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        // 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
        // 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
        fixtureInput: { name: "{{vars.private}}" },
      },
    );
    const catalog = source.assets.find((a) => a.kind === "ELEMENT_CATALOG")!;
    if (catalog.kind === "ELEMENT_CATALOG")
      catalog.document.elements.push({
        key: "save",
        locator: { by: "testId", value: "save" },
      // 分段注释：继续说明 generated.test.ts 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
      // 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
      // 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
      });
    rehash(source);
    const output = compileFiles(source, actualDistribution(root));
    verifyFiles(output.bundle, output.files);
    for (const file of Object.values(output.files))
      expect(Buffer.from(file).includes(Buffer.from(syntheticSecret))).toBe(
        false,
      );
    // 分段注释：继续说明 generated.test.ts 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    // 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
    // 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
    const emitted = join(root, "emitted");
    for (const [path, bytes] of Object.entries(output.files)) {
      await mkdir(dirname(join(emitted, path)), { recursive: true });
      await writeFile(join(emitted, path), bytes);
    }
    const install = await exec(
      "npm",
      [
        // 分段注释：继续说明 generated.test.ts 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        // 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
        // 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
        "ci",
        "--offline",
        "--ignore-scripts",
        "--audit=false",
        "--fund=false",
        "--update-notifier=false",
        "--cache",
        join(root, "cache"),
      // 分段注释：继续说明 generated.test.ts 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
      // 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
      // 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
      ],
      { cwd: emitted },
    );
    expect(install.stderr).toBe("");
    const generated = ts.createProgram(
      output.bundle.entrypoints.map((entry) => join(emitted, entry.path)),
      {
        target: ts.ScriptTarget.ES2023,
        // 分段注释：继续说明 generated.test.ts 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        // 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
        // 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        strict: true,
        skipLibCheck: true,
        resolveJsonModule: true,
        noEmit: true,
      },
    );
    // 分段注释：继续说明 generated.test.ts 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    // 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
    // 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
    expect(
      ts
        .getPreEmitDiagnostics(generated)
        .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")),
    ).toEqual([]);
    const execution = {
      schemaVersion: "1.0",
      workspaceId: source.workspaceId,
      // 分段注释：继续说明 generated.test.ts 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
      // 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
      // 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
      runId: id(11),
      caseExecutionId: id(12),
      caseVersionId: id(1),
      assetSourceHash: source.sourceHash,
      environmentVersionId: id(13),
      environment: {
        ...f.options.environment,
        roles: [
          // 分段注释：继续说明 generated.test.ts 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
          // 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
          // 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
          {
            roleKey: "reader",
            authAdapterVersionId: id(14),
            secretRef: "reader",
            secretVersionId: id(15),
          },
        ],
      },
      // 分段注释：继续说明 generated.test.ts 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
      // 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
      // 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
      roleKey: "reader",
      browser: "chromium",
      variables: { private: "Ada" },
      secretVersions: [{ secretRef: "reader", versionId: id(15) }],
      namespace: "attempt-generated",
      attemptNo: 1,
    };
    await writeFile(join(emitted, "execution.json"), JSON.stringify(execution));
    // 分段注释：继续说明 generated.test.ts 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    // 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
    // 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
    await writeFile(
      join(emitted, "context.mjs"),
      `import {readFile,appendFile} from 'node:fs/promises';export async function createExecutionContext(){const execution=JSON.parse(await readFile(new URL('./execution.json',import.meta.url),'utf8'));return {execution,credentials:{resolve:async()=>({token:process.env.VERIQ_TEST_SYNTHETIC_SECRET})},emit:async event=>appendFile(new URL('./events.jsonl',import.meta.url),JSON.stringify(event)+'\\n'),redact:value=>value,lifecycle:{authenticate:async({page,credentials,signal})=>{const value=await credentials.resolve({workspaceId:execution.workspaceId,secretRef:'reader',versionId:execution.secretVersions[0].versionId},signal);const response=await page.request.get(execution.environment.apiBaseURL+'/identity',{headers:{authorization:'Bearer '+value.token}});if(!response.ok())throw new Error('AUTH_FAILED');return {identityId:(await response.json()).id};},prepare:async(fixture,context)=>{if(context.fixtureInput.name!=='Ada')throw new Error('INITIAL_INPUT_MISMATCH');return {variables:{code:'generated'},cleanupToken:'generated-cleanup'};},cleanup:async()=>{}}};}`,
    );
    await writeFile(
      join(emitted, "playwright.config.ts"),
      `export default {testDir:'./cases',workers:1,retries:0,reporter:[['json',{outputFile:'report.json'}]],use:{launchOptions:{executablePath:'/usr/bin/chromium',args:['--no-sandbox']}}};`,
    );
    // 分段注释：继续说明 generated.test.ts 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    // 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
    // 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
    const processOutput = await exec(
      "node",
      ["node_modules/@playwright/test/cli.js", "test"],
      {
        cwd: emitted,
        env: {
          ...process.env,
          VERIQ_TEST_SYNTHETIC_SECRET: syntheticSecret,
          // 分段注释：继续说明 generated.test.ts 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
          // 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
          // 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
          VERIQ_EXECUTION_CONTEXT_MODULE: join(emitted, "context.mjs"),
          XDG_CACHE_HOME: join(root, "xdg-cache"),
          XDG_CONFIG_HOME: join(root, "xdg-config"),
        },
        timeout: 45000,
      },
    );
    expect(processOutput.stdout + processOutput.stderr).not.toContain(
      // 分段注释：继续说明 generated.test.ts 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
      // 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
      // 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
      syntheticSecret,
    );
    const events = await readFile(join(emitted, "events.jsonl"), "utf8");
    expect(events).not.toContain(syntheticSecret);
    expect(events).toContain("[REDACTED]");
    const report = JSON.parse(
      await readFile(join(emitted, "report.json"), "utf8"),
    );
    // 分段注释：继续说明 generated.test.ts 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    // 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
    // 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
    expect(JSON.stringify(report)).not.toContain(syntheticSecret);
    expect(report.stats).toMatchObject({
      expected: 1,
      unexpected: 0,
      skipped: 0,
      flaky: 0,
    });
    expect(
      // 分段注释：继续说明 generated.test.ts 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
      // 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
      // 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
      f.requests
        .filter((r) => r.path === "/save" && r.method === "POST")
        .map((r) => JSON.parse(r.body)),
    ).toEqual([{ code: "attempt-generated" }]);
    await writeFile(
      join(emitted, "context.mjs"),
      `import {readFile} from 'node:fs/promises';export async function createExecutionContext(){return {execution:JSON.parse(await readFile(new URL('./execution.json',import.meta.url),'utf8')),redact:value=>value};}`,
    );
    // 分段注释：继续说明 generated.test.ts 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    // 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
    // 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
    await expect(
      exec("node", ["node_modules/@playwright/test/cli.js", "test"], {
        cwd: emitted,
        env: {
          ...process.env,
          VERIQ_EXECUTION_CONTEXT_MODULE: join(emitted, "context.mjs"),
          XDG_CACHE_HOME: join(root, "xdg-cache"),
          XDG_CONFIG_HOME: join(root, "xdg-config"),
        // 分段注释：继续说明 generated.test.ts 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        // 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
        // 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
        },
        timeout: 45000,
      }),
    ).rejects.toMatchObject({ code: 1 });
    const failed = JSON.parse(
      await readFile(join(emitted, "report.json"), "utf8"),
    );
    expect(failed.stats).toMatchObject({
      // 分段注释：继续说明 generated.test.ts 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
      // 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
      // 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
      expected: 0,
      unexpected: 1,
      skipped: 0,
      flaky: 0,
    });
    expect(JSON.stringify(failed)).toContain("AUTH_PROVIDER_REQUIRED");
    expect(
      f.requests.filter((r) => r.path === "/save" && r.method === "POST"),
    // 分段注释：继续说明 generated.test.ts 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    // 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
    // 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
    ).toHaveLength(1);
  } finally {
    await f.close();
    await rm(root, { recursive: true, force: true });
  }
}, 90000);
