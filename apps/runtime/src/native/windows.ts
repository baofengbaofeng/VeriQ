/** Windows 原生模块只在真实 Windows 分支延迟装载，Linux 的既有进程与套接字路径不接触该依赖；接口只描述有限私有传输、ACL 和身份操作，不向业务脚本提供任意系统调用或原始句柄。 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { basename } from "node:path";
import { verifiedNativeAddon, type RuntimeDistribution } from "../distribution.ts";

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
    /** 原子更新在已验证父句柄下创建临时成员并提交，首次注册可明确禁止覆盖；提交后刷新不确定性原样抛出，不执行回调、自动重试或回退普通 Node 文件写入，默认仍保持既有替换行为。 */
    replacePrivate(
        directory: string,
        name: string,
        temporary: string,
        content: string,
        createOnly?: boolean,
    ): void;
    /** 退休仅针对有限普通私有成员并在原生持有的父链及文件句柄上完成，未知权限或重解析错误继续上抛；成功表示删除标记和句柄释放完成，不代表存储介质已擦除或目录断电持久化。 */
    removePrivate(path: string): void;
    /** Cookie 检查或退役仅处理固定 VeriQ 分区数据库及其日志，严格验证父链与同一真实句柄后返回存在事实；六十四兆元数据上限不扩张配置或保险库读取容量，删除成功也不表示物理擦除。 */
    privateCookieFile(path: string, retire: boolean): boolean;
    /** 保险库专用入口只接受固定 vault 目录下的清单、日志及随机记录名称，容量限定为两兆字节以容纳认证信封；一般私有配置仍保持原额度，三个操作继续使用原生同句柄拥有者与父链校验。 */
    readVaultFile(path: string): Buffer;
    /** 保险库替换限定固定目录成员与两兆字节正文，沿用同父目录和源文件句柄完成刷新与原子发布；提交后错误继续表示结果不确定，调用方必须读取恢复日志而不能重放业务更新或退回普通路径写入。 */
    replaceVaultFile(directory: string, name: string, temporary: string, content: string): void;
    /** 保险库退休只删除当前用户拥有的有界普通成员，验证仍由已持有父链和实际文件句柄完成；成功不表示物理擦除，未知删除或关闭错误必须传播，不能把访问拒绝归类为不存在后继续清理其他用途。 */
    removeVaultFile(path: string): void;
    takePipeDiagnostics(): Array<{ phase: string; code: string; win32: number; checks: number }>;
}
let loaded: WindowsNative | undefined;
let loadedPath: string | undefined;
let installedPath: string | undefined;
/** 安装宿主仅能绑定完整库存解析器颁发的原生能力，先前装载的开发模块或另一发行不能被静默替换；绑定立即使用标准 Node 加载器检查真实模块，失败不会继续读取私有档案或回退其它代码位置。 */
export function bindWindowsDistribution(distribution: RuntimeDistribution): void {
    const path = verifiedNativeAddon(distribution);
    if ((loadedPath && loadedPath !== path) || (installedPath && installedPath !== path))
        throw new Error("WINDOWS_NATIVE_BINDING_CHANGED");
    installedPath = path;
    windowsNative();
}
/** 构建期产生的 Node-API 模块通过标准 Node 加载器进入宿主，安装角色必须先绑定已核验库存能力；普通开发 Node 保留明确源码布局，已安装角色缺失能力时不搜索全局模块、配置路径或开发副本。 */
export function windowsNative(): WindowsNative {
    if (process.platform !== "win32") throw new Error("WINDOWS_NATIVE_PLATFORM_REQUIRED");
    if (!installedPath && /^veriq_(agent|cli|runner)(?:\.exe)?$/i.test(basename(process.execPath)))
        throw new Error("WINDOWS_NATIVE_DISTRIBUTION_REQUIRED");
    const path =
        installedPath ??
        fileURLToPath(new URL("../../build/Release/veriq_native.node", import.meta.url));
    if (!loaded) {
        loaded = createRequire(import.meta.url)(path) as WindowsNative;
        loadedPath = path;
    }
    return loaded;
}
