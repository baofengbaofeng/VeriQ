/** VeriQ 桌面共享入口只导出已经实现的业务视图和适配器，使用 Web 自身配置生成独立声明与静态资源；桌面严格工程消费产物而不继承旧 Web 的类型兼容选项。 */
export { installHostTransport, type HostTransport, type Workspace } from "./api";
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
export { AiWorkspaceView } from "./features/ai/AiPage";
export { CloudAiAdapter } from "./features/ai/adapters";
export { editorI18n } from "./features/resources/i18n";
export { aiI18n } from "./features/ai/i18n";
import "./style.css";
