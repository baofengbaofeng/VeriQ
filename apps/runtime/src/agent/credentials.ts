/**
 * 本文件实现设备会话与凭证公平队列：单一 Agent 以 proper-lockfile 排他锁占有配置目录，请求串行取用令牌并十二小时续期。
 */
import lockfile from 'proper-lockfile';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { DeviceStore, RuntimeClient, type DeviceConfig } from '../enrollment.ts';
/** One native Agent owns a profile. Each bounded control request takes one fair queue turn. */
/**
 * 公开类 DeviceSession 表示单一原生 Agent 对配置目录的独占所有权，控制请求经公平队列串行取用设备凭证。
 * open 以排他锁占据 agent-owner；withCredential 在十二小时窗口内复用令牌，到期则经 RuntimeClient 续期。
 */
export class DeviceSession {
    private tail: Promise<unknown> = Promise.resolve();
    private nextRenewal = 0;
    private release: (() => Promise<void>) | undefined;
    constructor(readonly store: DeviceStore, readonly client: RuntimeClient) { }
    /**
     * 公开方法 open 准备设备存储并锁定 agent-owner 目录，确保同一配置根上只有一个 Agent 存活（open）。
     */
    async open() {
        await this.store.prepare();
        const owner = join(this.store.directory, 'agent-owner');
        await mkdir(owner, { mode: 0o700, recursive: true });
        this.release = await lockfile.lock(owner, { retries: 0 });
        try {
            await this.withCredential(async () => undefined);
        }
        catch (error) {
            await this.close();
            throw error;
        }
    }
    /**
     * 公开方法 close 排空凭证队列尾并释放 agent-owner 锁，允许后续进程重新取得该配置目录所有权（close）。
     */
    async close() { await this.tail.catch(() => { }); await this.release?.(); this.release = undefined; }
    /**
     * 公开方法 withCredential 把操作排入公平队列，在需要时续期设备令牌后把配置交给调用方回调执行（catch）。
     */
    withCredential<T>(operation: (config: DeviceConfig) => Promise<T>): Promise<T> {
        const next = this.tail.catch(() => { }).then(async () => {
            let config: DeviceConfig;
            if (performance.now() >= this.nextRenewal) {
                config = await this.store.renew(this.client);
                this.nextRenewal = performance.now() + 12 * 60 * 60 * 1000;
            }
            else
                config = await this.store.load();
            return operation(config);
        });
        this.tail = next;
        return next;
    }
}
