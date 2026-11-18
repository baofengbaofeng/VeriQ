/**
 * 集成用例通过真实设备会话和监督器执行一个已认领任务，可指定已安装浏览器以验证软件包行为，独立发行验收另行运行。
 */
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
await session.open();
try {
    const client = new AgentClient(session);
    const root = join(profile, "agent");
    const supervisor = new ExecutionSupervisor({ client, root, releaseDirectory, browserExecutable });
    const { entry } = await loadRelease(releaseDirectory, "0.1.0");
    const { capabilities } = await doctor({ executablePath: browserExecutable, distribution: entry });
    if (!capabilities) throw new Error("PACKAGE_DIAGNOSTICS_FAILED");
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
