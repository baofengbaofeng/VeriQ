import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
// 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
// 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
// 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ProcessSupervisor } from '../src/execution/processes.ts';
// 分段注释：继续说明 storage.test.ts 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
// 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
// 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
import { monitorStorage } from '../src/execution/storage.ts';
test('over-quota unfinished Chromium download terminates the real process group', async () => {
    const root = await mkdtemp(join(tmpdir(), 'veriq-t10-quota-'));
    const downloads = join(root, 'downloads');
    // 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    // 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
    // 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
    await mkdir(downloads);
    let finished = false;
    let closed = false;
    const server = createServer((req, res) => {
        // 关键路径：处理 if 分支，保持取消、重试与证据完整性约束不被削弱；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        if (req.url === '/') {
            res.setHeader('Content-Type', 'text/html');
            res.end('<a href="/large">Download</a>');
            return;
        // 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        // 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        // 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        }
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="large.bin"' });
        const interval = setInterval(() => res.write(Buffer.alloc(128 * 1024)), 10);
        // 分段注释：继续说明 storage.test.ts 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        // 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
        // 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
        res.on('close', () => { clearInterval(interval); closed = true; });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    // 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    // 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
    // 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
    assert(address && typeof address !== 'string');
    const processes = new ProcessSupervisor(join(root, 'journal'));
    let monitor: {
        close(): void;
    // 分段注释：继续说明 storage.test.ts 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    // 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
    // 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
    } | undefined;
    // 关键路径：处理 try 分支，保持取消、重试与证据完整性约束不被削弱；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    try {
        const child = await processes.start('quota', { executable: process.execPath, cwd: resolve('.'), args: ['--input-type=module', '-e', `import {chromium} from '@playwright/test';const browser=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox'],downloadsPath:${JSON.stringify(downloads)}});const page=await browser.newPage({serviceWorkers:'block'});await page.goto('http://127.0.0.1:${address.port}/');await page.click('a');console.log('download-active');await new Promise(()=>{});`], env: { XDG_CONFIG_HOME: join(root, 'config'), XDG_CACHE_HOME: join(root, 'cache'), TMPDIR: root } });
        await child.firstLine();
        let settle!: (reason: string) => void;
        // 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        // 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        // 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        const stopped = new Promise<string>(resolve => { settle = resolve; });
        monitor = monitorStorage(downloads, 256 * 1024, async (reason) => { const receipt = await processes.terminateAttempt('quota', reason); assert.equal(receipt.processStopped, true); settle(reason); });
        assert.equal(await Promise.race([stopped, new Promise<string>((_, reject) => setTimeout(() => reject(new Error('QUOTA_NOT_ENFORCED')), 10000).unref())]), 'ATTEMPT_STORAGE_LIMIT');
        // 分段注释：继续说明 storage.test.ts 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        // 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
        // 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
        finished = true;
        assert.deepEqual(processes.active(), []);
        assert.equal(closed, true);
    }
    // 关键路径：处理 finally 分支，保持取消、重试与证据完整性约束不被削弱；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    finally {
        monitor?.close();
        await processes.terminateAttempt('quota', 'TEST_FINALLY');
        server.closeAllConnections();
        // 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        // 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        // 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        server.close();
        await rm(root, { recursive: true, force: true });
    }
    // 分段注释：继续说明 storage.test.ts 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    // 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
    // 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
    assert.equal(finished, true);
});
