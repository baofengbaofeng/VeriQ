/**
 * 宿主完成私有轮次的网络复核后，只有原卡片所在的会话、标签和工作区仍然有效，才消费刚签发的单次票据。
 */
import type { DesktopBridge } from "../shared/bridge";

export async function openAgentFormInBrowser(
    bridge: Pick<DesktopBridge, "prepareAgentWebForm" | "openAgentWebForm">,
    ref: Parameters<DesktopBridge["prepareAgentWebForm"]>[0],
    signal: AbortSignal,
) {
    if (signal.aborted) return;
    const ticket = await bridge.prepareAgentWebForm(ref);
    if (!signal.aborted) await bridge.openAgentWebForm(ticket);
}
