/** Darwin 文件基础首先通过已有正式消费者观察正常私有文件行为，测试不导入尚未实现的原生适配或构建脚本；临时根的系统别名仅由测试准备解析，产品目录访问仍必须自行拒绝链接。
 * 两个消费者都使用公开构造入口，避免直接读取测试自己创建的文件而漏掉平台分派缺口。
 * 合成记录没有凭据、停止证明或发行能力，成功只表示有限文件操作能够连接已有业务接口。
 * 同一文件会在真实 Mac 的两个架构运行，测试名称和断言保持一致以比较实现前后的结果。
 * Linux 上运行只能检查测试准备与现有路径兼容，不能作为 Darwin 的失败或通过证据。
 * 导入全部指向当前已存在的源码，因此首轮失败不会来自未实现的 addon 或构建入口。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProcessRecords } from "../../src/execution/records.ts";
import { VaultFiles } from "../../src/credentials/files.ts";

/** macOS 的临时目录可能经由系统别名暴露，因此先解析宿主临时根再创建本次唯一七百权限目录；清理只接触 mkdtemp 返回的测试目录，不删除已有历史，也不为正式消费者预先放宽权限或模拟文件操作。
 * realpath 只应用于操作系统提供的临时根，正式接口不会得到通过别名访问的授权示例。
 * mkdtemp 创建的随机目录属于当前进程用户，满足只读记录类要求的最终私有目录条件。
 * 回调发生任何断言或消费者错误仍会进入 finally，因此真实 RED 不遗留下一轮可见状态。
 * 每个测试各自创建目录，保险库写入不会影响记录枚举，也不会把并发顺序作为通过条件。
 * fixture 不执行 chmod 或特权操作；正常样本从创建开始就带有要求的访问模式。
 */
async function fixture(run: (directory: string) => Promise<void>): Promise<void> {
    const directory = await mkdtemp(join(await realpath(tmpdir()), "veriq-darwin-private-"));
    try {
        await run(directory);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

/** 只读历史的正常路径必须真正返回可用会话而不是把缺少目录能力解释成记录不存在；当前 macOS 缺少 Linux 的 proc 文件系统，此断言将保存缺口的实际失败，同时后续读取证明使用了正式记录类。
 * 记录按正式 Attempt 成员语法命名，有限正文采用当前用户拥有的六百模式普通文件。
 * open 返回 undefined 在这里属于失败，因为测试此前已经创建了确切存在的私有目录。
 * 该断言让当前 Mac 的能力缺失显示为产品行为失败，不把缺失记录当作符合预期的成功。
 * names 必须完整返回唯一普通成员，其限额恰为一，不能通过过滤或只读取目录路径替代。
 * read 使用正式六万五千五百三十六字节上限并比较解析结果，覆盖实际字节读取和 JSON 解码。
 * 构造成功后始终关闭会话；读取或枚举断言失败也不能让目录描述符依赖垃圾回收释放。
 * 正常内容没有 STOPPED 状态，因此此基础测试不会为任何进程停止或历史迁移提供授权。
 */
test("ProcessRecords opens an existing private directory and reads its normal record", async () =>
    fixture(async (directory) => {
        const value = { state: "ALLOCATED", attemptId: "mac-normal" };
        await writeFile(join(directory, "mac-normal.json"), JSON.stringify(value), { mode: 0o600 });
        const records = await ProcessRecords.open(directory);
        assert.ok(records, "Existing private records directory must open successfully");
        try {
            assert.deepEqual(await records.names(1), ["mac-normal.json"]);
            assert.deepEqual(await records.read("mac-normal.json", 65536), value);
        } finally {
            await records.close();
        }
    }));

/** 保险库正常路径直接调用已有会话的空目录判断、原子写入、读取和退休接口，确认后续实现必须连接真实业务消费者；测试仅使用公开合成正文，不启动系统凭据库、进程监督或 Chrome，也不依赖任何原生替身。
 * acquire 操作的目标是已存在的私有目录，避免用缺失目录解释当前 Mac 的打开失败。
 * 初始 empty 检查观察新目录，写入后 containsOnly 则观察同一会话内已发布的正式成员。
 * profile.json 是当前保险库白名单成员，不使用测试特权绕过用途名称或文件容量限制。
 * write 完成之后才读取完整合成字符串，后续 native 实现必须保持该调用的持久提交语义。
 * containsOnly 的允许集合仅含这次写入的名字，意外留下的临时成员不能被测试忽略。
 * remove 之后再次检查 empty，要求已发布成员确实退休，而非只让读取接口返回缺失。
 * finally 在写入、读取和删除任一阶段失败时关闭目录会话，保持父层明确拥有描述符生命周期。
 * 这里不注入故障或宣称完整边界覆盖，后续真实 Mac GREEN 后仍须补齐有界读取和提交异常矩阵。
 */
test("VaultFiles acquires a private directory and commits and removes a normal member", async () =>
    fixture(async (directory) => {
        const files = await VaultFiles.acquire(directory);
        try {
            assert.equal(await files.empty(), true);
            await files.write("profile.json", '{"fixture":"public-mac-normal"}');
            assert.equal(await files.read("profile.json"), '{"fixture":"public-mac-normal"}');
            assert.equal(await files.containsOnly(["profile.json"]), true);
            await files.remove("profile.json");
            assert.equal(await files.empty(), true);
        } finally {
            await files.close();
        }
    }));
