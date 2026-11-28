import { lstat, realpath } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test, expect, type _electron } from "../../apps/desktop/tests/fixtures";
import { captureTestAgent, stopTestAgent } from "./agent-owner";
import { startTestDesktopClose, trackDesktop } from "./desktop-close";

type Desktop = Awaited<ReturnType<typeof _electron.launch>>;

/**
 * 仅恢复用例跨越窗口退出与后继启动，所有权放在同一个测试级夹具中，正文超时后撤销后继启动并独立等待各自的释放回执。
 */
export class OwnedRecovery {
    private revoked = false;
    private readonly releases: (() => Promise<unknown>)[] = [];
    private readonly closing = new WeakMap<Desktop, ReturnType<typeof startTestDesktopClose>>();
    private readonly agents = new Map<string, Promise<Awaited<ReturnType<typeof captureTestAgent>>>>();
    private nextClose = Promise.resolve();
    private stopped?: Promise<void>;

    constructor(
        private readonly post: (url: string) => Promise<{ ok(): boolean }>,
        private readonly beginClose = startTestDesktopClose,
    ) {}

    business(action: "hold" | "release") {
        this.check();
        return this.post(`http://127.0.0.1:18891/__${action}`);
    }

    check() {
        if (this.revoked) throw new Error("RECOVERY_SCOPE_CLOSED");
    }

    defer(release: () => Promise<unknown>) {
        this.check();
        this.releases.push(release);
    }

    private startOwned<T>(start: () => Promise<T>, release: (value: T) => Promise<unknown>): Promise<T> {
        this.check();
        const pending = Promise.resolve().then(() => {
            this.check();
            return start();
        });
        this.defer(() => pending.then(release, () => {}));
        return pending;
    }

    acquire<T>(start: () => Promise<T>, release: (value: T) => Promise<unknown>): Promise<T> {
        return this.startOwned(start, release).then((value) => {
            this.check();
            return value;
        });
    }

    async launch(profile: string, start: () => Promise<Desktop>): Promise<Desktop> {
        this.check();
        if ((await realpath(profile)) !== profile) throw new Error("TEST_AGENT_PROFILE_CHANGED");
        let binding = this.agents.get(profile);
        if (!binding) {
            const existing = await lstat(join(profile, "desktop-agent.json")).catch((error: NodeJS.ErrnoException) => {
                if (error.code !== "ENOENT") throw error;
                return undefined;
            });
            if (existing) throw new Error("RECOVERY_PROFILE_ALREADY_OWNED");
        }
        this.check();
        // 此处同步登记两个独立的回收动作，启动一旦返回，关闭界面和捕获后台都无需等待旧正文继续执行。
        const launched = this.startOwned(
            async () => {
                const app = await start();
                trackDesktop(app);
                return app;
            },
            (app) => this.close(app),
        );
        if (!binding) {
            binding = launched.then(async () => {
                const deadline = performance.now() + 15000;
                for (;;) {
                    try {
                        return await captureTestAgent(profile);
                    } catch (error) {
                        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || performance.now() >= deadline)
                            throw error;
                        await delay(50);
                    }
                }
            });
            this.agents.set(profile, binding);
            const captured = binding;
            this.defer(async () => {
                const proof = await captured;
                await stopTestAgent(profile, proof.pid, proof);
            });
        }
        const [app] = await Promise.all([launched, binding]);
        this.check();
        return app;
    }

    async verifyAgent(profile: string, pid: number) {
        if ((await this.agents.get(profile))?.pid !== pid) throw new Error("TEST_AGENT_IDENTITY_MISMATCH");
        this.check();
    }

    close(app: Desktop, intent: "quit" | "cleanup" = "cleanup") {
        if (intent === "quit") this.check();
        let result = this.closing.get(app);
        if (!result) {
            const started = this.nextClose.then(() => this.beginClose(app, intent));
            const exited = started.then((ticket) => ticket.exited);
            const drained = started.then((ticket) => ticket.drained);
            void drained.catch(() => {});
            this.nextClose = exited.catch(() => {});
            result = { exited, drained };
            this.closing.set(app, result);
        }
        return intent === "quit" ? result.exited : result.drained;
    }

    stop(): Promise<void> {
        this.revoked = true;
        this.stopped ??= Promise.allSettled(
            this.releases.toReversed().map((release) => Promise.resolve().then(release)),
        ).then((results) => {
            const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
            if (failures.length) throw new AggregateError(failures, "RECOVERY_FIXTURE_CLEANUP_FAILED");
        });
        return this.stopped;
    }
}

export const recoveryTest = test.extend<{ owned: OwnedRecovery }>({
    owned: async ({ request }, use, info) => {
        const owned = new OwnedRecovery((url) => request.post(url));
        try {
            await use(owned);
        } finally {
            const stopped = owned.stop();
            await expect
                .poll(
                    async () => {
                        await stopped;
                        return true;
                    },
                    {
                        timeout: info.project.timeout,
                        message: "Owned recovery cleanup must complete in the teardown budget",
                    },
                )
                .toBe(true);
        }
    },
});
