import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * 每次桌面验收调用只在全局准备阶段签发一次随机交接标识并清除旧清单，worker 重启继承同轮标识，不得读取上轮成功档案求绿。
 * 旧私有档案保留供诊断，只移除固定交接文件；当前轮完成真实工作流后才能写入与候选及本轮标识共同绑定的新清单。
 */
export default async function prepareDesktopSuite(): Promise<void> {
    const root = resolve("../..");
    const evidence = resolve(root, process.env.VERIQ_DESKTOP_EVIDENCE ?? ".superpowers/sdd/veriq-1/evidence/t19");
    await mkdir(evidence, { recursive: true });
    const suiteId = randomUUID();
    process.env.VERIQ_DESKTOP_SUITE_ID = suiteId;
    await rm(resolve(evidence, "connected-workflow-fixture.json"), { force: true });
    await writeFile(resolve(evidence, "desktop-suite.json"), JSON.stringify({ suiteId }, null, 4) + "\n");
}
