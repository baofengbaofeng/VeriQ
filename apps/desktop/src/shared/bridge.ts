import type { PlatformComponents } from "@veriq/contracts";
import type { CredentialIssue } from "./credential-status";
import type { CloudOperation } from "./operations.generated";
type S = PlatformComponents["schemas"];

/** 公开桌面状态只包含可显示的配置、会话摘要与后台事实，目录路径和设备凭证不属于这个接口；每个窗口获得的工作区选择都由宿主确认，而不是以客户端角色字段授权。 */
export interface DesktopState {
    origin: string;
    user?: { user: S["UserDTO"]; expiresAt: string };
    workspace?: S["WorkspaceDTO"];
    agent?: AgentState;
    tray: boolean;
    version: string;
}
/** 后台状态是持久执行信息的无密钥投影，上传失败保留错误和 PENDING 状态以支持显式重试；进程版本与 pid 用于诊断独立运行，不给 renderer 发送操作系统控制能力。 */
export interface AgentState {
    node: string;
    pid: number;
    active: { workspaceId: string; runId: string; attemptId: string; state: string } | null;
    online: boolean;
    preparing?: { id: string; operation: "run" | "onlineStart"; cancelling: boolean };
    device?: { id: string; workspaceId: string };
    workspaceId?: string;
    bundles: {
        id: string;
        workspaceId: string;
        engineVersion: string;
        createdAt: string;
        debug: boolean;
    }[];
    history: {
        id: string;
        createdAt: string;
        state: string;
        uploadState: string;
        uploadError: string | null;
    }[];
    error?: string;
    credentialError?: CredentialIssue;
    headedAvailable: boolean;
    browser: { available: boolean; version?: string; source: string };
}
/** 本机操作集合逐项枚举业务参数，包、Run 与制品只能通过标识引用；任意 URL、文件路径、请求头和进程参数不在协议内，秘密只能按已验签的凭证引用写入而不能读回。 */
export type LocalOperation =
    | {
          operation:
              | "status"
              | "doctor"
              | "pollEnrollment"
              | "device"
              | "unbind"
              | "onlineStart"
              | "onlineStop"
              | "recover"
              | "migrateCredentials"
              | "recoverCredentialInitialization";
      }
    | { operation: "select"; workspaceId: string }
    | { operation: "enroll"; name: string }
    | { operation: "trust"; issuer: S["IssuerTrustV1"]; fingerprint: string }
    | { operation: "download"; bundleId: string; debug: boolean }
    | { operation: "snapshot" | "credentials" | "clearBundle"; bundleId: string }
    | {
          operation: "source";
          bundleId: string;
          versionId: string;
          file: { path: string; sha256: string; sizeBytes: number };
      }
    | {
          operation: "setCredential" | "removeCredential";
          bundleId: string;
          reference: {
              issuerId: string;
              workspaceId: string;
              secretRef: string;
              versionId: string;
          };
          value?: unknown;
      }
    | {
          operation: "run";
          bundleId: string;
          headed: boolean;
          retry: boolean;
          overrides?: import("./routing").RoutingOverride;
      }
    | { operation: "cancel" | "report" | "upload"; runId: string }
    | { operation: "cancel"; startupId: string };
/** DesktopBridge 是 preload 唯一公开能力集合，云端流逐块拉取且能够取消；原始证据只能请求宿主确认后保存或查看，renderer 不接触 Cookie、设备 token 或明文保险库内容。 */
export interface DesktopBridge {
    /** 读取主窗口会话与后台的无密钥状态投影，后台不可达可以作为独立诊断事实返回；这个接口不隐式启动业务执行，也不把缓存 Cookie 的存在等同于服务端仍认可登录。 */
    state(): Promise<DesktopState>;
    /** 保存经宿主校验的控制 Origin 与无凭证代理配置，只影响后续明确连接的目的地；配置变更须遵守已有设备绑定约束，不能借设置表单把执行令牌转发至另一个平台。 */
    configure(origin: string, proxy: string): Promise<void>;
    /** 将用户本次输入提交到宿主专用 Cookie 会话，返回仅含用户摘要和到期时间的公开对象；密码不会进入后台设备配置，masked CSRF 与 Cookie 都不通过返回值读取。 */
    login(data: S["LoginRequest"]): Promise<{ user: S["UserDTO"]; expiresAt: string }>;
    /** 撤销普通员工会话并清理对应宿主 Cookie 与旧流，页面随后失去当前云端授权；设备登记是独立身份，已经开始的本机业务不会因为这个操作被伪装成注销或取消。 */
    logout(): Promise<void>;
    /** 列举当前普通登录用户实际可访问的工作区，不从本地签名包列表推导远程成员权限；选择某个条目前宿主仍会再次检查该工作区，因此列表缓存不能作为访问凭证。 */
    workspaces(): Promise<{ items: S["WorkspaceDTO"][]; nextCursor: string | null }>;
    /** 请求宿主切换当前云端工作区并返回重新检查后的成员视图，旧报告订阅随作用域撤销；参数只包含 UUID，调用方不能提交角色或凭证字段来扩张自己的权限。 */
    select(workspaceId: string): Promise<S["WorkspaceDTO"]>;
    /** 发送生成白名单中的有限云端业务操作，主进程重新验证名称、参数、正文与工作区；返回 unknown 迫使消费端使用对应业务 DTO，类型声明本身不承诺未经检查的数据可信。 */
    cloud(operation: CloudOperation): Promise<unknown>;
    /** 发送有限本机业务命令给独立 Node Agent，资源通过已登记标识引用并再次检查归属；此入口不公开宿主专用原始证据命令，也不接受任意文件路径或可执行程序参数。 */
    local(operation: LocalOperation): Promise<unknown>;
    /** 申请一个绑定当前会话和工作区的报告流句柄，宿主会同时计算等待连接与已打开流的名额；返回标识仅用于后续拉取和关闭，不能用于建立另一个地址的网络连接。 */
    streamOpen(operation: CloudOperation): Promise<string>;
    /** 从已持有的流读取下一块有界字节并显式报告结束，背压来自页面的拉取节奏；会话切换或关闭后旧标识立即失效，不允许用同一标识继续读取之前工作区的数据。 */
    streamPull(id: string): Promise<{ done: boolean; bytes?: Uint8Array }>;
    /** 显式释放当前宿主持有的流句柄，重复关闭已结束的流保持幂等并取消底层 reader；组件卸载和请求取消都调用此方法，不需要向 renderer 暴露网络连接对象。 */
    streamClose(id: string): Promise<void>;
    /** 为指定 Run、Attempt 和制品请求原生保存或查看，主进程先完成本机确认及当前归属检查；页面只表达固定动作而不能选择读取路径，原始字节也不会作为调用返回值泄露。 */
    artifact(input: {
        local: boolean;
        runId: string;
        attemptId: string;
        artifactId: string;
        action: "save" | "trace" | "preview";
    }): Promise<void>;
    /** 明确区分收起窗口、退出界面与停止后台三种生命周期请求，破坏性或有活动执行的操作由宿主确认；退出 UI 不意味着取消 Run，停止成功须等待独立后台真实收尾。 */
    lifecycle(action: "hide" | "quit" | "stop"): Promise<void>;
    /** 请求操作系统打开当前可信档案目录供用户自行查看，路径由宿主配置决定且不接受页面参数；这不是通用文件浏览器接口，页面不能借此读取文件内容或指定可执行程序。 */
    directory(): Promise<void>;
}
