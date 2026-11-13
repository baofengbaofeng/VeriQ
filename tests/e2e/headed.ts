import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, readdir, readlink, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "../../apps/desktop/tests/fixtures";

const command = promisify(execFile);
type Observation = {
    windowId: string;
    pid: number;
    workerPid: number;
    guardianPid: number;
    attemptId: string;
    ancestors: number[];
    executable: string;
    arguments: string[];
    display: string;
    mode: "headed";
    browserVersion: "158.0.8127.18";
    mapState: "IsViewable";
};

/** 进程目录可能在窗口枚举后正常消失，因此读取某一已观察 PID 的字段只把内核报告的消失当作候选失效；权限错误和其它 I/O 失败继续抛出，避免在取证循环中把真正的宿主问题静默重试。 */
async function processField(
    pid: number,
    field: "stat" | "environ" | "cmdline",
): Promise<string | undefined> {
    try {
        return await readFile(`/proc/${pid}/${field}`, "utf8");
    } catch (error) {
        if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? ""))
            return undefined;
        throw error;
    }
}

/** 原生窗口树同时包含根窗口、父窗口元数据和子窗口记录，枚举器只提供 XID 候选而不证明窗口可见或进程归属；调用方仍必须执行实际 xprop、IsViewable、二进制及祖先链验证，不能用文本匹配代替真实窗口检查。 */
export function x11WindowIds(tree: string): string[] {
    return (tree.match(/0x[0-9a-f]+/gi) ?? []).filter((id) => BigInt(id) !== 0n);
}

/** 业务响应被夹具暂缓期间，从真实 X11 窗口反查完整浏览器及监管器后代关系，并读取该 Attempt 的实际生成配置与 worker 显示环境；所有观察都来自本轮拥有的进程，不能另起一个示例浏览器代替 runOffline 的接线证明。 */
export async function observeHeadedRun(
    profile: string,
    agentPid: number,
    executable: string,
    evidence: string,
): Promise<Observation> {
    const display = process.env.DISPLAY;
    if (!display) throw new Error("TEST_DISPLAY_REQUIRED");
    const binary = await realpath(executable);
    expect((await command(binary, ["--version"])).stdout).toContain("158.0.8127.18");
    const directory = join(profile, "offline", "processes");
    const journals = await Promise.all(
        (await readdir(directory))
            .filter((name) => name.endsWith(".process.json"))
            .map(
                async (name) =>
                    JSON.parse(await readFile(join(directory, name), "utf8")) as {
                        state: string;
                        attemptId: string;
                        pid: number;
                        guardianPid: number;
                    },
            ),
    );
    const active = journals.filter((item) => item.state === "RUNNING");
    expect(active).toHaveLength(1);
    const owned = active[0];
    if (!owned) throw new Error("TEST_ACTIVE_WORKER_REQUIRED");
    let observation: Observation | undefined;
    await expect
        .poll(
            async () => {
                const tree = (await command("xwininfo", ["-root", "-tree"])).stdout;
                for (const windowId of x11WindowIds(tree)) {
                    let pid: number;
                    try {
                        const property = (await command("xprop", ["-id", windowId, "_NET_WM_PID"]))
                            .stdout;
                        pid = Number(property.match(/=\s*(\d+)/)?.[1]);
                        if (!Number.isSafeInteger(pid) || pid <= 1) continue;
                        if ((await readlink(`/proc/${pid}/exe`)) !== binary) continue;
                        const window = (await command("xwininfo", ["-id", windowId])).stdout;
                        if (!/Map State:\s*IsViewable/.test(window)) continue;
                    } catch (error) {
                        // 枚举和读取窗口属性不是原子操作，正常销毁的窗口或刚退出进程可从候选集合移除；只接受这些明确的失效信号，其余显示连接、权限或命令失败必须终止验收而不能吞掉。
                        const failure = error as NodeJS.ErrnoException & { stderr?: string };
                        if (
                            ["ENOENT", "ESRCH"].includes(failure.code ?? "") ||
                            /BadWindow \(invalid Window parameter\)/.test(failure.stderr ?? "")
                        )
                            continue;
                        throw error;
                    }
                    const ancestors = [pid];
                    let cursor = pid;
                    for (let i = 0; i < 20 && cursor !== agentPid && cursor > 1; i++) {
                        const stat = await processField(cursor, "stat");
                        if (stat === undefined) return false;
                        cursor = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
                        ancestors.push(cursor);
                    }
                    expect(ancestors).toContain(owned.pid);
                    expect(ancestors).toContain(owned.guardianPid);
                    expect(ancestors).toContain(agentPid);
                    const rawEnvironment = await processField(owned.pid, "environ");
                    const rawCommand = await processField(pid, "cmdline");
                    if (rawEnvironment === undefined || rawCommand === undefined) return false;
                    const environment = rawEnvironment.split("\0");
                    const arguments_ = rawCommand.split("\0").filter(Boolean);
                    expect(arguments_.some((argument) => argument.startsWith("--headless"))).toBe(
                        false,
                    );
                    expect(environment).toContain(`DISPLAY=${process.env.DISPLAY}`);
                    if (process.env.XAUTHORITY)
                        expect(environment).toContain(`XAUTHORITY=${process.env.XAUTHORITY}`);
                    const config = await readFile(
                        join(profile, "offline", "work", owned.attemptId, "playwright.config.mjs"),
                        "utf8",
                    );
                    const actual = JSON.parse(
                        config.slice("export default ".length, config.lastIndexOf(";")),
                    ) as { use: { headless: boolean; launchOptions: { executablePath: string } } };
                    expect(actual.use.headless).toBe(false);
                    expect(await realpath(actual.use.launchOptions.executablePath)).toBe(binary);
                    observation = {
                        windowId,
                        pid,
                        workerPid: owned.pid,
                        guardianPid: owned.guardianPid,
                        attemptId: owned.attemptId,
                        ancestors,
                        executable: binary,
                        arguments: arguments_,
                        display,
                        mode: "headed",
                        browserVersion: "158.0.8127.18",
                        mapState: "IsViewable",
                    };
                    return true;
                }
                return false;
            },
            { timeout: 10000 },
        )
        .toBe(true);
    if (!observation) throw new Error("HEADED_WINDOW_MISSING");
    await command("import", [
        "-window",
        observation.windowId,
        join(evidence, "headed-visible.png"),
    ]);
    await writeFile(
        join(evidence, "headed-observation.json"),
        JSON.stringify(observation, null, 4) + "\n",
    );
    return observation;
}

/** 可见运行结束后同时核对平台报告的停止事实、本机监管器终态及真实窗口消失，再确认该次拥有的 PID 已退出；先前的窗口截图只证明加载，不能单独证明浏览器和 worker 已被原停止路径收敛。 */
export async function assertHeadedStopped(
    profile: string,
    observation: Observation,
    processStopped: unknown,
    evidence: string,
) {
    expect(processStopped).toBe(true);
    const journal = JSON.parse(
        await readFile(
            join(profile, "offline", "processes", `${observation.attemptId}.process.json`),
            "utf8",
        ),
    ) as { state: string };
    expect(journal.state).toBe("STOPPED");
    await expect
        .poll(async () =>
            (await command("xwininfo", ["-root", "-tree"])).stdout.includes(observation.windowId),
        )
        .toBe(false);
    for (const pid of [observation.pid, observation.workerPid, observation.guardianPid]) {
        await expect
            .poll(async () => {
                try {
                    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
                    return stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z ");
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
                    throw error;
                }
            })
            .toBe(true);
    }
    await writeFile(
        join(evidence, "headed-stopped.json"),
        JSON.stringify(
            {
                attemptId: observation.attemptId,
                processStopped,
                journalState: journal.state,
                windowGone: true,
                ownedPidsExited: true,
            },
            null,
            4,
        ) + "\n",
    );
}
