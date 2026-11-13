/** Windows 原生模块只在真实 Windows 分支延迟装载，Linux 的既有进程与套接字路径不接触该依赖；接口只描述有限私有传输、ACL 和身份操作，不向业务脚本提供任意系统调用或原始句柄。 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

/** 原生进程身份使用字符串保存完整 FILETIME 和 SID，避免 JavaScript 数字精度丢失造成 PID 重用判断失效；running 来自已打开内核进程句柄，而不是映像名称或系统进程列表猜测。 */
export interface WindowsIdentity {
    sid: string;
    startTime: string;
    running: boolean;
}
/** 管道服务器持有实际监听和连接句柄，close 返回时原生线程已结束；请求回调只接受一个有界 UTF8 帧及一次响应函数，业务授权仍由既有 nonce 和有限 TypeScript 分派处理器负责。 */
export interface WindowsNative {
    sid: string;
    PrivatePipeServer: new (
        path: string,
        receive: (frame: string, reply: (frame: string) => void) => void,
    ) => { close(): void };
    request(path: string, frame: string): Promise<string>;
    identity(pid: number): WindowsIdentity | null;
    /** 停止请求同时提供守护和工作进程的精确身份，原生层持有两者句柄并匹配同一私有事件后才发送；已退出工作进程仍可由守护句柄保留身份，不能把其他 Attempt 的 nonce 与独立真实 PID 拼接成权限。 */
    signalStop(
        nonce: string,
        guardianPid: number,
        guardianStartTime: string,
        workerPid: number,
        workerStartTime: string,
    ): void;
    privatePath(path: string, createDirectory: boolean): void;
    writePrivate(path: string, content: string): void;
    /** 私有读取在原生层持有同一文件句柄完成 ACL、重解析与大小检查后才返回有限字节，调用者不会先检查字符串路径再通过另一个文件描述符读取，因此配置内容不能被中间路径替换转移。 */
    readPrivateFile(path: string, limit: number): Buffer;
    /** 原子更新只在已验证的目录句柄下创建随机临时成员并提交正式名称，提交后的刷新不确定性原样抛出；该接口不会执行回调、自动重试或在原生失败时回退到普通 Node 文件写入。 */
    replacePrivate(directory: string, name: string, temporary: string, content: string): void;
    takePipeDiagnostics(): Array<{ phase: string; code: string; win32: number; checks: number }>;
}
let loaded: WindowsNative | undefined;
/** 构建期产生的 Node-API 模块通过标准 Node 加载器进入宿主，缺失或 ABI 错误直接失败；此处没有下载、编译、公共传输或额外 node.exe 回退，安装路径后续由已核验库存的构建布局提供。 */
export function windowsNative(): WindowsNative {
    if (process.platform !== "win32") throw new Error("WINDOWS_NATIVE_PLATFORM_REQUIRED");
    return (loaded ??= createRequire(import.meta.url)(
        fileURLToPath(new URL("../../build/Release/veriq_native.node", import.meta.url)),
    ) as WindowsNative);
}
