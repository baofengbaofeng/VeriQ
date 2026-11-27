/**
 * VeriQ 桌面共享入口只导出已经实现的业务视图和适配器，使用 Web 自身配置生成独立声明与静态资源；桌面严格工程消费产物而
 * 不继承旧 Web 的类型兼容选项。
 */
export { installHostTransport, type HostTransport, type Workspace } from "./api";
export { canonicalBytes } from "@veriq/contracts";
export { ResourceWorkspaceView } from "./features/resources/ResourcePage";
export {
    CloudResourceAdapter,
    LocalResourceAdapter,
    type ResourceAdapter,
    type LocalResourceSnapshot,
} from "./features/resources/adapters";
export { ReportWorkspaceView } from "./features/reports/ReportPage";
export {
    CloudReportAdapter,
    LocalReportAdapter,
    type ReportAdapter,
    type LocalReportSnapshot,
} from "./features/reports/adapters";
export { BundleWorkspaceView } from "./features/bundles/BundlePage";
export { CloudBundleAdapter, type BundleAdapter } from "./features/bundles/adapters";
export { AgentWorkspaceView } from "./features/agent/AgentWorkspaceView";
export { CloudAgentAdapter } from "./features/agent/adapters";
export { AiWorkspaceView } from "./features/ai/AiPage";
export { CloudAiAdapter } from "./features/ai/adapters";
export { editorI18n } from "./features/resources/i18n";
export { aiI18n } from "./features/ai/i18n";
export { canExportWorkspaceTable } from "./table-view";
import "./style.css";
import "./menu-focus";

/**
 * 桌面可把共享语言 Provider 与原生语言控件放进自身窗口壳，继续使用同一持久化偏好和受控实例桥接；此导出不引入
 * BrowserRouter，也不会要求宿主加载远程 Web 页面。
 */
export { AppLocaleProvider, LanguageControl } from "./locale-ui";
export { appI18n, setAppLanguage } from "./locale";

export { RecordingStepConfiguration } from "./features/cases/CaseEditor";
export type { VersionOption as RecordingVersionOption } from "./features/resources/fields";

export { validateCaseSchema as validateRecordingCase } from "@veriq/contracts";
