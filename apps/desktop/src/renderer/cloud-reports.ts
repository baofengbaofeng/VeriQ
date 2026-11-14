import type { PlatformComponents } from "@veriq/contracts";
import type { ReportAdapter } from "@veriq/web/desktop";
import type { DesktopBridge } from "../shared/bridge";

type Report = PlatformComponents["schemas"]["RunReportDTO"];

/** 云端报告的原生证据按钮使用已展示报告建立的 Attempt 到 Run 归属，装饰器保留共享报告读取和订阅接口；这个映射只提供请求上下文，main 与服务端仍重新执行工作区、制品范围和当前权限检查。 */
export function nativeCloudReports(
    workspaceId: string,
    reports: ReportAdapter,
    artifact: DesktopBridge["artifact"],
): ReportAdapter {
    const runs = new Map<string, string>();
    const remember = (report: Report, runId: string) => {
        if (report.run.workspaceId !== workspaceId || report.run.id !== runId)
            throw new Error("REPORT_CONTEXT_MISMATCH");
        for (const item of report.cases)
            for (const attempt of item.attempts) {
                const previous = runs.get(attempt.id);
                if (previous && previous !== runId) throw new Error("REPORT_CONTEXT_MISMATCH");
                runs.set(attempt.id, runId);
            }
        return report;
    };
    const original = reports.report.bind(reports);
    reports.report = async (...args) => remember(await original(...args), args[0]);
    const subscribe = reports.subscribe.bind(reports);
    reports.subscribe = (runId, receive, signal) =>
        subscribe(runId, (report) => receive(remember(report, runId)), signal);
    return Object.assign(reports, {
        nativeArtifact: async (
            attemptId: string,
            artifactId: string,
            action: "save" | "trace" | "preview",
        ) => {
            const runId = runs.get(attemptId);
            if (!runId) throw new Error("REPORT_CONTEXT_MISSING");
            await artifact({ local: false, runId, attemptId, artifactId, action });
        },
    });
}
