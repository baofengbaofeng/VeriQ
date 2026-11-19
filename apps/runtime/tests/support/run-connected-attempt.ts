/**
 * 集成用例通过真实设备会话和监督器执行一个已认领任务，可指定已安装浏览器以验证软件包行为，独立发行验收另行运行。
 */
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import { DeviceStore, RuntimeClient } from "../../src/enrollment.ts";
import { DeviceSession } from "../../src/agent/credentials.ts";
import { AgentClient } from "../../src/agent/transport.ts";
import { doctor } from "../../src/doctor.ts";
import { loadRelease } from "../../src/execution/release.ts";
import { claimLoop } from "../../src/agent/claim-loop.ts";
import { ExecutionSupervisor } from "../../src/execution/supervisor.ts";

const [profile, releaseDirectory, browserExecutable] = process.argv.slice(2);
if (!profile || !releaseDirectory || !browserExecutable) throw new Error("TEST_INPUT_REQUIRED");
const store = new DeviceStore(profile);
const config = await store.load();
const session = new DeviceSession(store, new RuntimeClient(config.server));
const deadline = performance.now() + 20000;
for (;;) {
    try {
        await session.open();
        break;
    } catch (error) {
        if (
            process.argv[5] !== "recover" ||
            (error as NodeJS.ErrnoException).code !== "ELOCKED" ||
            performance.now() >= deadline
        )
            throw error;
        await delay(250);
    }
}
try {
    const client = new AgentClient(session);
    const root = join(profile, "agent");
    const supervisor = new ExecutionSupervisor({ client, root, releaseDirectory, browserExecutable });
    const { entry } = await loadRelease(releaseDirectory, "0.1.0");
    const { capabilities } = await doctor({ executablePath: browserExecutable, distribution: entry });
    if (!capabilities) throw new Error("PACKAGE_DIAGNOSTICS_FAILED");
    if (process.argv[5] === "recover") {
        const stops = await supervisor.recover();
        if (!stops.length || stops.some((stop) => !stop.processStopped)) throw new Error("RECOVERY_UNCONFIRMED");
    } else
        await claimLoop({
            client,
            root,
            supervisor,
            runnerId: config.runnerId,
            capabilities,
            signal: AbortSignal.timeout(120000),
            once: true,
        });
} finally {
    await session.close();
}
