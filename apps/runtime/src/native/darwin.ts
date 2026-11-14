/** Darwin 私有文件适配仅在真实 Mac 分支延迟加载本架构开发产物，现阶段安装库存没有可信 Darwin 能力，因此正式角色一律失败关闭；模块不搜索全局路径、不回退 Windows addon，也不开放执行或 doctor。
 * 所有 API 都同步完成有限原生操作，业务用途白名单和更小读取额度保留在调用者。
 * File 对象拥有 fd 生命周期，整数借用不能用于构造新的授权对象。
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { basename } from "node:path";

/** 普通私有文件对象只来自当前目录的独占创建并持有原始 inode，fd 只借给所属 CLI 的显式 stdio 映射；调用方必须保活对象直到实际 CLI 退出及最终日志校验完成，再明确关闭，不能仅保存整数。
 * read 不移动共享文件偏移，仍核实际文件 owner、模式、单链接和有界长度。
 * close 幂等，错误后也不再拥有原描述符，因此不能自动重试关闭数字。
 */
export interface DarwinPrivateFile {
    readonly fd: number;
    read(limit: number): Buffer;
    close(): void;
}

/** 有界枚举返回完整观察到的有限名字和独立 overflow 标记，未识别成员不能被过滤为安全空目录；每次使用独立原生游标并以不跟随链接的元数据检查拒绝非普通或不私有的条目。
 * limit 零仍观察第一项，因此 empty 不会被空返回数组误导。
 * 正式调用者在这些名字上继续执行自己的用途语法及扫描数量限制。
 */
export interface DarwinPrivateEntries {
    names: string[];
    overflow: boolean;
}

/** 目录会话持有从根逐级无链接打开的真实目录描述符，路径重命名不改变后续成员操作锚点；replace 单独接收已有成员限额，新正文始终另受原生两兆上限，不放宽 local-secrets 等较小配置。
 * createExclusive 的文件和父目录刷新成功后才交付拥有者，重复名字不会覆盖。
 * remove/replace 发布后的必要刷新或关闭失败返回 COMMIT_UNCONFIRMED，由业务层保持恢复语义。
 * close 仅关闭目录自身，已交付 File 继续由其独立拥有者负责。
 */
export interface DarwinPrivateDirectory {
    read(name: string, limit: number): Buffer;
    entries(limit: number): DarwinPrivateEntries;
    createExclusive(name: string): DarwinPrivateFile;
    replace(name: string, temporary: string, bytes: Buffer, existingLimit: number): void;
    remove(name: string, limit: number): void;
    close(): void;
}

/** 原生入口只允许绝对路径与显式创建布尔值，目录链校验和最终 owner/七百模式在实际描述符上执行；只读打开不创建、不 realpath、不修权限，缺失之外的任何拒绝都不能解释为没有历史。
 * 该接口只提供文件能力，不签发安装发行能力或进程停止证明。
 * 公开函数类型用于约束正式消费者与独立测试，不向调用方暴露原始目录 fd。
 */
export interface DarwinNative {
    openPrivateDirectory(path: string, create: boolean): DarwinPrivateDirectory;
}
let loaded: DarwinNative | undefined;

/** 开发装载只接受普通 Node 宿主和固定源码相邻的 Darwin 产物位置，现阶段没有安装库存绑定入口；veriq 角色或 Electron 等其他宿主缺少可信能力时明确拒绝，不能读取开发副本冒充已安装验收。
 * Darwin 产物使用独立目录及名称，避免覆盖 Windows 已有库存身份。
 * Node 标准加载器会验证实际 Mach-O/ABI，装载失败原样传播且不另寻替代路径。
 * 缓存只在真实加载成功后写入，不把缺失模块变成空能力或文件路径后备。
 */
export function darwinNative(): DarwinNative {
    if (process.platform !== "darwin") throw new Error("DARWIN_NATIVE_PLATFORM_REQUIRED");
    if (basename(process.execPath) !== "node")
        throw new Error("DARWIN_NATIVE_DISTRIBUTION_REQUIRED");
    loaded ??= createRequire(import.meta.url)(
        fileURLToPath(new URL("../../build/darwin/veriq_private_files.node", import.meta.url)),
    ) as DarwinNative;
    return loaded;
}
