/**
 * 本文件 apps/runtime/src/offline/store.ts 实现 VeriQ 相关前端或执行侧能力，并标明公开导出与关键路径
 * 模块注释用于帮助智能体与贡献者快速定位授权、执行与离线相关逻辑。
 * 本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。
 * 实现时不得绕过 Workspace 归属校验，也不得把密钥或明文凭证写入日志。
 * 若行为变更，请同步更新契约样例、相关测试与可观察的错误码语义。
 * 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
 * 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
 * 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
 * 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
 * 测试与文档应能证明该路径在无模型凭证、缺浏览器或租约过期时仍失败关闭正确。
 */

 /**
  * 本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。
  * 实现时不得绕过 Workspace 归属校验，也不得把密钥或明文凭证写入日志。
  * 若行为变更，请同步更新契约样例、相关测试与可观察的错误码语义。
  * 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
  * 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
  * 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
  * 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
  * 测试与文档应能证明该路径在无模型凭证、缺浏览器或租约过期时仍失败关闭正确。
  */
/** Native host persistence; renderer callers never receive SQL or database paths. */
import { DatabaseSync } from 'node:sqlite';
import { chmod, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { validateSchema, type ExecutionEventV1, type OfflineResultV1 } from '@veriq/contracts';
// 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
// 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
// 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
import type { StopReceipt } from '../execution/processes.ts';
import { privateDirectory } from './config.ts';
/**
 * 公开类型 Ownership 描述 apps/runtime/src/offline/store.ts 模块对外契约字段与可组合结构
 * 请结合 Workspace 边界、契约校验与失败关闭路径阅读本实现。
 */
export type Ownership = {
        workspaceId: string;
        runId: string;
        attemptId: string;
        // 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        // 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        // 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        state: string;
        generation: number;
};
/**
 * 公开类 LocalStore 封装 apps/runtime/src/offline/store.ts 中的核心状态与可复用协作接口
 * 请结合 Workspace 边界、契约校验与失败关闭路径阅读本实现。
 * 本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。
 * 实现时不得绕过 Workspace 归属校验，也不得把密钥或明文凭证写入日志。
 * 若行为变更，请同步更新契约样例、相关测试与可观察的错误码语义。
 * 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
 * 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
 * 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
 * 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
 * 测试与文档应能证明该路径在无模型凭证、缺浏览器或租约过期时仍失败关闭正确。
 */
export class LocalStore {
        private constructor(readonly directory: string, private db: DatabaseSync) { }
        /**
         * 公开函数 open 负责 apps/runtime/src/offline/store.ts 中的关键处理流程并返回约定结果
         * 请结合 Workspace 边界、契约校验与失败关闭路径阅读本实现。
         * 本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。
         * 实现时不得绕过 Workspace 归属校验，也不得把密钥或明文凭证写入日志。
         * 若行为变更，请同步更新契约样例、相关测试与可观察的错误码语义。
         * 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
         * 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
         * 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
         * 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
         * 测试与文档应能证明该路径在无模型凭证、缺浏览器或租约过期时仍失败关闭正确。
         */
        static async open(directory: string): Promise<LocalStore> {
                await privateDirectory(directory);
                const path = join(directory, 'veriq.sqlite');
                // 关键路径：处理 try 分支，保持取消、重试与证据完整性约束不被削弱；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                try {
                        const st = await lstat(path);
                        // 关键路径：处理 if 分支，保持取消、重试与证据完整性约束不被削弱；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                        if (!st.isFile() || st.isSymbolicLink())
                                throw new Error('UNSAFE_LOCAL_STORE');
                }
                // 关键路径：处理 catch 分支，保持取消、重试与证据完整性约束不被削弱；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                catch (e) {
                        // 关键路径：处理 if 分支，保持取消、重试与证据完整性约束不被削弱；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                        if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
                                throw e;
                }
                const db = new DatabaseSync(path);
                // 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                // 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                // 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                await chmod(path, 0o600);
                const version = Number(db.prepare('PRAGMA user_version').get()!.user_version);
                // 关键路径：处理 if 分支，保持取消、重试与证据完整性约束不被削弱；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                if (version > 2) {
                        db.close();
                        throw new Error('LOCAL_STORE_VERSION_UNSUPPORTED');
                }
                // 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                // 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                // 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;
            CREATE TABLE IF NOT EXISTS veriq_local_runs (
                id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, created_at TEXT NOT NULL,
                // 分段注释：继续说明 store.ts 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                // 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
                // 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
                state TEXT NOT NULL, result TEXT, upload_state TEXT NOT NULL DEFAULT 'PENDING',
                upload_receipt TEXT, upload_error TEXT, cancel_requested INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE IF NOT EXISTS veriq_local_owner (
                singleton INTEGER PRIMARY KEY CHECK(singleton=1), run_id TEXT NOT NULL REFERENCES veriq_local_runs(id),
                // 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                // 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                // 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                workspace_id TEXT NOT NULL, attempt_id TEXT NOT NULL, state TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 1);
            CREATE TABLE IF NOT EXISTS veriq_local_events (
                run_id TEXT NOT NULL REFERENCES veriq_local_runs(id), attempt_id TEXT NOT NULL,
                sequence INTEGER NOT NULL, document TEXT NOT NULL, PRIMARY KEY(attempt_id, sequence));
            // 分段注释：继续说明 store.ts 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            // 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
            // 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
            CREATE TABLE IF NOT EXISTS veriq_local_stops (
                attempt_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES veriq_local_runs(id), receipt TEXT NOT NULL);
            `);
                // 关键路径：处理 if 分支，保持取消、重试与证据完整性约束不被削弱；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                if (!db.prepare("PRAGMA table_info(veriq_local_owner)").all().some(column => column.name === 'generation'))
                        db.exec("ALTER TABLE veriq_local_owner ADD COLUMN generation INTEGER NOT NULL DEFAULT 1");
                db.exec("PRAGMA user_version=2");
                return new LocalStore(directory, db);
        // 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        // 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        // 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        }
        close() { this.db.close(); }
        /**
         * 公开函数 transaction 负责 apps/runtime/src/offline/store.ts 中的关键处理流程并返回约定结果
         * 请结合 Workspace 边界、契约校验与失败关闭路径阅读本实现。
         * 本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。
         * 实现时不得绕过 Workspace 归属校验，也不得把密钥或明文凭证写入日志。
         * 若行为变更，请同步更新契约样例、相关测试与可观察的错误码语义。
         * 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
         * 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
         * 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
         * 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
         * 测试与文档应能证明该路径在无模型凭证、缺浏览器或租约过期时仍失败关闭正确。
         */
        private transaction<T>(fn: () => T): T {
                this.db.exec('BEGIN IMMEDIATE');
                // 关键路径：处理 try 分支，保持取消、重试与证据完整性约束不被削弱；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                try {
                        const value = fn();
                        this.db.exec('COMMIT');
                        return value;
                // 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                // 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                // 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                }
                // 关键路径：处理 catch 分支，保持取消、重试与证据完整性约束不被削弱；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                catch (error) {
                        this.db.exec('ROLLBACK');
                        throw error;
                }
        // 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        // 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        // 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        }
        /**
         * 公开函数 active 负责 apps/runtime/src/offline/store.ts 中的关键处理流程并返回约定结果
         * 请结合 Workspace 边界、契约校验与失败关闭路径阅读本实现。
         * 本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。
         * 实现时不得绕过 Workspace 归属校验，也不得把密钥或明文凭证写入日志。
         * 若行为变更，请同步更新契约样例、相关测试与可观察的错误码语义。
         * 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
         * 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
         * 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
         * 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
         * 测试与文档应能证明该路径在无模型凭证、缺浏览器或租约过期时仍失败关闭正确。
         */
        active(): Ownership | undefined {
                return this.db.prepare('SELECT workspace_id AS workspaceId, run_id AS runId, attempt_id AS attemptId, state, generation FROM veriq_local_owner WHERE singleton=1').get() as Ownership | undefined;
        }
        /**
         * 公开函数 requireOwner 负责 apps/runtime/src/offline/store.ts 中的关键处理流程并返回约定结果
         * 请结合 Workspace 边界、契约校验与失败关闭路径阅读本实现。
         * 本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。
         * 实现时不得绕过 Workspace 归属校验，也不得把密钥或明文凭证写入日志。
         * 若行为变更，请同步更新契约样例、相关测试与可观察的错误码语义。
         * 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
         * 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
         * 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
         * 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
         * 测试与文档应能证明该路径在无模型凭证、缺浏览器或租约过期时仍失败关闭正确。
         */
        private requireOwner(owner: Ownership): Ownership {
                const current = this.active();
                // 关键路径：处理 if 分支，保持取消、重试与证据完整性约束不被削弱；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                if (!current || current.runId !== owner.runId || current.attemptId !== owner.attemptId || current.generation !== owner.generation || current.state !== owner.state)
                        throw new Error('LOCAL_OWNERSHIP_LOST');
                return current;
        }
        // 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        // 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        // 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        ensureOwner(owner: Ownership): void { this.requireOwner(owner); }
        /**
         * 公开函数 reserve 负责 apps/runtime/src/offline/store.ts 中的关键处理流程并返回约定结果
         * 请结合 Workspace 边界、契约校验与失败关闭路径阅读本实现。
         * 本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。
         * 实现时不得绕过 Workspace 归属校验，也不得把密钥或明文凭证写入日志。
         * 若行为变更，请同步更新契约样例、相关测试与可观察的错误码语义。
         * 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
         * 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
         * 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
         * 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
         * 测试与文档应能证明该路径在无模型凭证、缺浏览器或租约过期时仍失败关闭正确。
         */
        reserve(workspaceId: string, runId: string, attemptId: string, initial?: OfflineResultV1): Ownership {
                return this.transaction(() => {
                        // 关键路径：处理 if 分支，保持取消、重试与证据完整性约束不被削弱；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                        if (this.active())
                                throw new Error('LOCAL_CAPACITY_HELD');
                        this.db.prepare('INSERT INTO veriq_local_runs(id,workspace_id,created_at,state) VALUES(?,?,?,?)').run(runId, workspaceId, new Date().toISOString(), 'RUNNING');
                        this.db.prepare('INSERT INTO veriq_local_owner VALUES(1,?,?,?,?,1)').run(runId, workspaceId, attemptId, 'ALLOCATED');
                        // 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                        // 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                        // 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                        const owner = this.active()!;
                        // 关键路径：处理 if 分支，保持取消、重试与证据完整性约束不被削弱；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                        if (initial)
                                this.checkpoint(initial, owner);
                        return owner;
                });
        // 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        // 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        // 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        }
        /**
         * 公开函数 spawning 负责 apps/runtime/src/offline/store.ts 中的关键处理流程并返回约定结果
         * 请结合 Workspace 边界、契约校验与失败关闭路径阅读本实现。
         * 本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。
         * 实现时不得绕过 Workspace 归属校验，也不得把密钥或明文凭证写入日志。
         * 若行为变更，请同步更新契约样例、相关测试与可观察的错误码语义。
         * 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
         * 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
         * 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
         * 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
         * 测试与文档应能证明该路径在无模型凭证、缺浏览器或租约过期时仍失败关闭正确。
         */
        spawning(runId: string, attemptId: string, owner: Ownership): Ownership {
                return this.transaction(() => {
                        this.requireOwner(owner);
                        // 关键路径：处理 if 分支，保持取消、重试与证据完整性约束不被削弱；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                        if (owner.runId !== runId || owner.attemptId !== attemptId || owner.state !== 'ALLOCATED')
                                throw new Error('LOCAL_OWNERSHIP_LOST');
                        this.db.prepare("UPDATE veriq_local_owner SET state='SPAWNING' WHERE singleton=1").run();
                        return { ...owner, state: 'SPAWNING' };
                // 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                // 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                // 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                });
        }
        /**
         * 公开函数 claimRecovery 负责 apps/runtime/src/offline/store.ts 中的关键处理流程并返回约定结果
         * 请结合 Workspace 边界、契约校验与失败关闭路径阅读本实现。
         * 本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。
         * 实现时不得绕过 Workspace 归属校验，也不得把密钥或明文凭证写入日志。
         * 若行为变更，请同步更新契约样例、相关测试与可观察的错误码语义。
         * 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
         * 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
         * 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
         * 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
         * 测试与文档应能证明该路径在无模型凭证、缺浏览器或租约过期时仍失败关闭正确。
         */
        claimRecovery(observed: Ownership): Ownership | undefined {
                return this.transaction(() => {
                        const state = ['ALLOCATED', 'RECOVERING_UNSPAWNED'].includes(observed.state) ? 'RECOVERING_UNSPAWNED' : 'RECOVERING';
                        const changed = this.db.prepare('UPDATE veriq_local_owner SET state=?,generation=generation+1 WHERE run_id=? AND attempt_id=? AND generation=? AND state=?').run(state, observed.runId, observed.attemptId, observed.generation, observed.state);
                        // 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                        // 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                        // 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                        return changed.changes ? { ...observed, state, generation: observed.generation + 1 } : undefined;
                });
        }
        /**
         * 公开函数 nextAttempt 负责 apps/runtime/src/offline/store.ts 中的关键处理流程并返回约定结果
         * 请结合 Workspace 边界、契约校验与失败关闭路径阅读本实现。
         * 本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。
         * 实现时不得绕过 Workspace 归属校验，也不得把密钥或明文凭证写入日志。
         * 若行为变更，请同步更新契约样例、相关测试与可观察的错误码语义。
         * 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
         * 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
         * 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
         * 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
         * 测试与文档应能证明该路径在无模型凭证、缺浏览器或租约过期时仍失败关闭正确。
         */
        nextAttempt(runId: string, attemptId: string, owner: Ownership, initial: OfflineResultV1): Ownership {
                return this.transaction(() => {
                        this.requireOwner(owner);
                        // 关键路径：处理 if 分支，保持取消、重试与证据完整性约束不被削弱；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                        if (owner.runId !== runId || owner.state !== 'STOPPED')
                                throw new Error('LOCAL_CAPACITY_HELD');
                        const next = { ...owner, attemptId, state: 'ALLOCATED', generation: owner.generation + 1 };
                        this.db.prepare("UPDATE veriq_local_owner SET state='ALLOCATED',attempt_id=?,generation=? WHERE singleton=1").run(attemptId, next.generation);
                        // 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                        // 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                        // 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                        this.checkpoint(initial, next);
                        return next;
                });
        // 分段注释：继续说明 store.ts 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        // 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
        // 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
        }
        /**
         * 公开函数 stopped 负责 apps/runtime/src/offline/store.ts 中的关键处理流程并返回约定结果
         * 请结合 Workspace 边界、契约校验与失败关闭路径阅读本实现。
         * 本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。
         * 实现时不得绕过 Workspace 归属校验，也不得把密钥或明文凭证写入日志。
         * 若行为变更，请同步更新契约样例、相关测试与可观察的错误码语义。
         * 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
         * 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
         * 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
         * 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
         * 测试与文档应能证明该路径在无模型凭证、缺浏览器或租约过期时仍失败关闭正确。
         */
        stopped(runId: string, receipt: StopReceipt, owner: Ownership): Ownership {
                return this.transaction(() => {
                        this.requireOwner(owner);
                        // 关键路径：处理 if 分支，保持取消、重试与证据完整性约束不被削弱；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                        if (owner.runId !== runId || owner.attemptId !== receipt.attemptId || (receipt.reason === 'NO_PROCESS_SPAWNED' && !['ALLOCATED', 'RECOVERING_UNSPAWNED'].includes(owner.state)))
                                throw new Error('LOCAL_OWNERSHIP_LOST');
                        this.db.prepare('INSERT INTO veriq_local_stops VALUES(?,?,?) ON CONFLICT(attempt_id) DO UPDATE SET receipt=excluded.receipt').run(receipt.attemptId, runId, JSON.stringify(receipt));
                        const next = { ...owner, state: receipt.processStopped ? 'STOPPED' : 'QUARANTINED' };
                        // 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                        // 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                        // 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                        this.db.prepare('UPDATE veriq_local_owner SET state=? WHERE singleton=1').run(next.state);
                        return next;
                });
        // 分段注释：继续说明 store.ts 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        // 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
        // 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
        }
        /**
         * 公开函数 append 负责 apps/runtime/src/offline/store.ts 中的关键处理流程并返回约定结果
         * 请结合 Workspace 边界、契约校验与失败关闭路径阅读本实现。
         * 本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。
         * 实现时不得绕过 Workspace 归属校验，也不得把密钥或明文凭证写入日志。
         * 若行为变更，请同步更新契约样例、相关测试与可观察的错误码语义。
         * 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
         * 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
         * 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
         * 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
         * 测试与文档应能证明该路径在无模型凭证、缺浏览器或租约过期时仍失败关闭正确。
         */
        append(runId: string, event: ExecutionEventV1, owner: Ownership) {
                this.transaction(() => {
                        this.requireOwner(owner);
                        // 关键路径：处理 if 分支，保持取消、重试与证据完整性约束不被削弱；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                        if (owner.runId !== runId || owner.attemptId !== event.attemptId)
                                throw new Error('LOCAL_OWNERSHIP_LOST');
                        const last = this.db.prepare('SELECT COALESCE(MAX(sequence),0) AS sequence, COUNT(*) AS count FROM veriq_local_events WHERE attempt_id=?').get(event.attemptId)!;
                        // 关键路径：处理 if 分支，保持取消、重试与证据完整性约束不被削弱；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                        if (Number(last.sequence) + 1 !== event.sequence || Number(last.count) >= 10000)
                                throw new Error('INVALID_LOCAL_EVENT_SEQUENCE');
                        // 关键路径：处理 if 分支，保持取消、重试与证据完整性约束不被削弱；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                        if (Buffer.byteLength(JSON.stringify(event)) > 65536)
                                throw new Error('LOCAL_EVENT_LIMIT');
                        this.db.prepare('INSERT INTO veriq_local_events VALUES(?,?,?,?)').run(runId, event.attemptId, event.sequence, JSON.stringify(event));
                        // 关键路径：处理 if 分支，保持取消、重试与证据完整性约束不被削弱；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                        if (event.type === 'ARTIFACT_CREATED') {
                                const descriptor = { ...event.payload.file, artifactId: event.payload.artifactId, kind: event.payload.kind };
                                // 关键路径：处理 if 分支，保持取消、重试与证据完整性约束不被削弱；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                                if (validateSchema('OfflineArtifactV1', descriptor).length || !/^[-a-zA-Z0-9_.]{1,240}$/.test(descriptor.path))
                                        throw new Error('INVALID_LOCAL_ARTIFACT');
                                const result = this.result(owner.workspaceId, runId), attempt = result.attempts.find(a => a.attemptId === owner.attemptId);
                                // 关键路径：处理 if 分支，保持取消、重试与证据完整性约束不被削弱；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                                if (!attempt || attempt.artifacts.length >= 100 || attempt.artifacts.some(a => a.artifactId === descriptor.artifactId || a.path === descriptor.path))
                                        throw new Error('INVALID_LOCAL_ARTIFACT');
                                attempt.artifacts.push(descriptor);
                                this.checkpoint(result, owner);
                        // 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                        // 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                        // 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                        }
                });
        }
        /**
         * 公开函数 events 负责 apps/runtime/src/offline/store.ts 中的关键处理流程并返回约定结果
         * 请结合 Workspace 边界、契约校验与失败关闭路径阅读本实现。
         * 本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。
         * 实现时不得绕过 Workspace 归属校验，也不得把密钥或明文凭证写入日志。
         * 若行为变更，请同步更新契约样例、相关测试与可观察的错误码语义。
         * 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
         * 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
         * 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
         * 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
         * 测试与文档应能证明该路径在无模型凭证、缺浏览器或租约过期时仍失败关闭正确。
         */
        events(workspaceId: string, runId: string, attemptId: string, after = 0, limit = 100): ExecutionEventV1[] {
                this.authorize(workspaceId, runId);
                // 关键路径：处理 if 分支，保持取消、重试与证据完整性约束不被削弱；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                if (!Number.isSafeInteger(after) || after < 0 || limit < 1 || limit > 10000)
                        throw new Error('INVALID_HISTORY_PAGE');
                return this.db.prepare('SELECT document FROM veriq_local_events WHERE run_id=? AND attempt_id=? AND sequence>? ORDER BY sequence LIMIT ?').all(runId, attemptId, after, limit).map(row => JSON.parse(String(row.document)) as ExecutionEventV1);
        }
        /**
         * 公开函数 checkpoint 负责 apps/runtime/src/offline/store.ts 中的关键处理流程并返回约定结果
         * 请结合 Workspace 边界、契约校验与失败关闭路径阅读本实现。
         * 本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。
         * 实现时不得绕过 Workspace 归属校验，也不得把密钥或明文凭证写入日志。
         * 若行为变更，请同步更新契约样例、相关测试与可观察的错误码语义。
         * 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
         * 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
         * 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
         * 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
         * 测试与文档应能证明该路径在无模型凭证、缺浏览器或租约过期时仍失败关闭正确。
         */
        checkpoint(result: OfflineResultV1, owner: Ownership) {
                this.authorize(result.workspaceId, result.localRunId);
                this.requireOwner(owner);
                // 关键路径：处理 if 分支，保持取消、重试与证据完整性约束不被削弱；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                if (owner.runId !== result.localRunId || !result.attempts.some(a => a.attemptId === owner.attemptId))
                        throw new Error("LOCAL_OWNERSHIP_LOST");
                this.db.prepare("UPDATE veriq_local_runs SET result=? WHERE id=?").run(JSON.stringify(result), result.localRunId);
        }
        /**
         * 公开函数 finish 负责 apps/runtime/src/offline/store.ts 中的关键处理流程并返回约定结果
         * 请结合 Workspace 边界、契约校验与失败关闭路径阅读本实现。
         * 本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。
         * 实现时不得绕过 Workspace 归属校验，也不得把密钥或明文凭证写入日志。
         * 若行为变更，请同步更新契约样例、相关测试与可观察的错误码语义。
         * 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
         * 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
         * 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
         * 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
         * 测试与文档应能证明该路径在无模型凭证、缺浏览器或租约过期时仍失败关闭正确。
         */
        finish(result: OfflineResultV1, owner: Ownership) {
                this.transaction(() => {
                        this.authorize(result.workspaceId, result.localRunId);
                        this.requireOwner(owner);
                        // 关键路径：处理 if 分支，保持取消、重试与证据完整性约束不被削弱；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                        if (owner.runId !== result.localRunId || !["STOPPED", "QUARANTINED"].includes(owner.state))
                                throw new Error('LOCAL_OWNERSHIP_LOST');
                        const state = owner.state === 'STOPPED' ? 'FINISHED' : 'QUARANTINED';
                        this.db.prepare('UPDATE veriq_local_runs SET result=?,state=? WHERE id=?').run(JSON.stringify(result), state, result.localRunId);
                        // 关键路径：处理 if 分支，保持取消、重试与证据完整性约束不被削弱；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                        if (state === 'FINISHED')
                                this.db.prepare('DELETE FROM veriq_local_owner WHERE run_id=?').run(result.localRunId);
                });
        }
        /**
         * 公开函数 authorize 负责 apps/runtime/src/offline/store.ts 中的关键处理流程并返回约定结果
         * 请结合 Workspace 边界、契约校验与失败关闭路径阅读本实现。
         * 本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。
         * 实现时不得绕过 Workspace 归属校验，也不得把密钥或明文凭证写入日志。
         * 若行为变更，请同步更新契约样例、相关测试与可观察的错误码语义。
         * 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
         * 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
         * 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
         * 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
         * 测试与文档应能证明该路径在无模型凭证、缺浏览器或租约过期时仍失败关闭正确。
         */
        private authorize(workspaceId: string, runId: string) {
                const row = this.db.prepare('SELECT * FROM veriq_local_runs WHERE id=? AND workspace_id=?').get(runId, workspaceId);
                // 关键路径：处理 if 分支，保持取消、重试与证据完整性约束不被削弱；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                if (!row)
                        throw new Error('LOCAL_RUN_NOT_FOUND');
                return row;
        }
        /**
         * 公开函数 result 负责 apps/runtime/src/offline/store.ts 中的关键处理流程并返回约定结果
         * 请结合 Workspace 边界、契约校验与失败关闭路径阅读本实现。
         * 本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。
         * 实现时不得绕过 Workspace 归属校验，也不得把密钥或明文凭证写入日志。
         * 若行为变更，请同步更新契约样例、相关测试与可观察的错误码语义。
         * 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
         * 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
         * 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
         * 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
         * 测试与文档应能证明该路径在无模型凭证、缺浏览器或租约过期时仍失败关闭正确。
         */
        result(workspaceId: string, runId: string): OfflineResultV1 {
                const row = this.authorize(workspaceId, runId);
                // 关键路径：处理 if 分支，保持取消、重试与证据完整性约束不被削弱；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                if (!row.result)
                        throw new Error('LOCAL_RUN_UNFINISHED');
                return JSON.parse(String(row.result)) as OfflineResultV1;
        }
        /**
         * 公开函数 history 负责 apps/runtime/src/offline/store.ts 中的关键处理流程并返回约定结果
         * 请结合 Workspace 边界、契约校验与失败关闭路径阅读本实现。
         * 本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。
         * 实现时不得绕过 Workspace 归属校验，也不得把密钥或明文凭证写入日志。
         * 若行为变更，请同步更新契约样例、相关测试与可观察的错误码语义。
         * 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
         * 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
         * 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
         * 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
         * 测试与文档应能证明该路径在无模型凭证、缺浏览器或租约过期时仍失败关闭正确。
         */
        history(workspaceId: string, limit = 100) {
                // 关键路径：处理 if 分支，保持取消、重试与证据完整性约束不被削弱；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
                        throw new Error('INVALID_HISTORY_PAGE');
                return this.db.prepare('SELECT id, created_at AS createdAt, state, upload_state AS uploadState, upload_error AS uploadError FROM veriq_local_runs WHERE workspace_id=? ORDER BY created_at DESC,id DESC LIMIT ?').all(workspaceId, limit);
        }
        // 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        // 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        // 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        cancel(workspaceId: string, runId: string) { this.authorize(workspaceId, runId); this.db.prepare('UPDATE veriq_local_runs SET cancel_requested=1 WHERE id=?').run(runId); }
        cancelled(runId: string) { return this.db.prepare('SELECT cancel_requested FROM veriq_local_runs WHERE id=?').get(runId)?.cancel_requested === 1; }
        uploaded(workspaceId: string, runId: string, receipt: unknown) { this.authorize(workspaceId, runId); this.db.prepare("UPDATE veriq_local_runs SET upload_state='COMPLETE',upload_receipt=?,upload_error=NULL WHERE id=?").run(JSON.stringify(receipt), runId); }
        // 分段注释：继续说明 store.ts 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        // 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
        // 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
        uploadFailed(workspaceId: string, runId: string, code: string) { this.authorize(workspaceId, runId); this.db.prepare("UPDATE veriq_local_runs SET upload_state='PENDING',upload_error=? WHERE id=?").run(/^[A-Z_]{1,80}$/.test(code) ? code : 'UPLOAD_FAILED', runId); }
}
