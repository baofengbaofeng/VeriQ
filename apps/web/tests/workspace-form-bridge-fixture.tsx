/**
 * 以桌面宿主的公开类型挂载真实表单卡；测试界面只记录授权次数及桥接参数，任何本机操作均不会实际执行。
 */
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { CapabilityCard } from "../src/features/agent/CapabilityCard";
import type { FormLauncher, WorkspaceFormCard } from "../src/features/agent/workspace-forms";
import { AppLocaleProvider } from "../src/locale-ui";

const workspaceId = "22222222-2222-4222-8222-222222222222";
const card: WorkspaceFormCard = { workspaceId, type: "OPEN_WORKSPACE_FORM", capability: "AUTH_CREDENTIALS" };
type Reference = Parameters<NonNullable<FormLauncher["openWebForm"]>>[0];

function BridgeFixture() {
    const [allow, setAllow] = useState(false);
    const [checks, setChecks] = useState(0);
    const [launches, setLaunches] = useState<Reference[]>([]);
    const [signal] = useState(() => new AbortController().signal);
    return (
        <>
            <CapabilityCard
                card={card}
                workspaceId={workspaceId}
                sessionId="33333333-3333-4333-8333-333333333333"
                turnId="44444444-4444-4444-8444-444444444444"
                signal={signal}
                authorize={async () => {
                    setChecks((count) => count + 1);
                    if (!allow) throw new Error("WORKSPACE_FORBIDDEN");
                    return card;
                }}
                launcher={{
                    platform: "desktop",
                    open: () => {
                        throw new Error("Unexpected native navigation");
                    },
                    openWebForm: async (ref) => setLaunches((current) => [...current, ref]),
                }}
            />
            <label>
                <input type="checkbox" checked={allow} onChange={(event) => setAllow(event.target.checked)} />
                Allow the next authorization
            </label>
            <output id="checks">{checks}</output>
            <output id="launches">{JSON.stringify(launches)}</output>
        </>
    );
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(
    <StrictMode>
        <AppLocaleProvider>
            <BridgeFixture />
        </AppLocaleProvider>
    </StrictMode>,
);
