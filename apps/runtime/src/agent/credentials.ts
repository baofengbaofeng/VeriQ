import lockfile from 'proper-lockfile';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { DeviceStore, RuntimeClient, type DeviceConfig } from '../enrollment.ts';
/** One native Agent owns a profile. Each bounded control request takes one fair queue turn. */
export class DeviceSession {
    private tail: Promise<unknown> = Promise.resolve();
    private nextRenewal = 0;
    private release: (() => Promise<void>) | undefined;
    constructor(readonly store: DeviceStore, readonly client: RuntimeClient) { }
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
    async close() { await this.tail.catch(() => { }); await this.release?.(); this.release = undefined; }
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
