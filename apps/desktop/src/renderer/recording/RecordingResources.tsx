import { useState } from "react";
import type { ResourceKind } from "@veriq/contracts";
import { AiWorkspaceView, ResourceWorkspaceView, WorkspaceIdentityManager, type Workspace } from "@veriq/web/desktop";
import type { cloudAdapters } from "../adapters";

type Tool = ResourceKind | "IDENTITY" | "AI";

const labels: Record<Tool, [string, string]> = {
    ELEMENT_CATALOG: ["元素目录", "Element catalogs"],
    DATASET: ["数据集", "Datasets"],
    FIXTURE: ["夹具", "Fixtures"],
    ASSERTION_TEMPLATE: ["断言模板", "Assertion templates"],
    ENVIRONMENT: ["环境", "Environments"],
    IDENTITY: ["鉴权与凭证", "Authentication and credentials"],
    FLOW: ["流程", "Flows"],
    CASE: ["用例", "Cases"],
    SUITE: ["用例集", "Suites"],
    AI: ["AI 辅助设计", "AI assistance"],
};

export function RecordingResources({
    workspace,
    adapters,
    signal,
    language,
}: {
    workspace: Workspace;
    adapters: ReturnType<typeof cloudAdapters>;
    signal: AbortSignal;
    language: "zh" | "en";
}) {
    const [tool, setTool] = useState<Tool>("ELEMENT_CATALOG");
    return (
        <section className="panel" data-testid="recording-resources-panel">
            <label>
                {language === "zh" ? "设计资源" : "Design resource"}
                <select
                    data-testid="recording-resource-kind"
                    value={tool}
                    onChange={(event) => setTool(event.target.value as Tool)}
                >
                    {Object.entries(labels).map(([key, names]) => (
                        <option key={key} value={key}>
                            {names[language === "zh" ? 0 : 1]}
                        </option>
                    ))}
                </select>
            </label>
            {tool === "IDENTITY" ? (
                <WorkspaceIdentityManager workspace={workspace} signal={signal} />
            ) : tool === "AI" ? (
                <AiWorkspaceView
                    workspace={workspace}
                    adapter={adapters.ai}
                    resources={adapters.resources}
                    signal={signal}
                />
            ) : (
                <ResourceWorkspaceView
                    key={tool}
                    workspace={workspace}
                    adapter={adapters.resources}
                    fixedKind={tool}
                    signal={signal}
                />
            )}
        </section>
    );
}
