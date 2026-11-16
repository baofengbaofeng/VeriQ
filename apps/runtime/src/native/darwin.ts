/**
 * Darwin 私有文件适配只从普通开发 Node 的固定产物或严格 Mac 库存授予的安装路径装载本架构模块，
 * 正式角色没有库存能力时仍失败关闭；模块不搜索全局路径、不回退 Windows addon，也不自行授权执行或 doctor
 * 。
 * 所有 API 都同步完成有限原生操作，业务用途白名单和更小读取额度保留在调用者。
 * File 对象拥有 fd 生命周期，整数借用不能用于构造新的授权对象。
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { basename } from "node:path";
import { verifiedNativeAddon, type RuntimeDistribution } from "../distribution.ts";

/**
 * 普通私有文件对象只来自当前目录的独占创建并持有原始 inode，fd 只借给所属 CLI 的显式 stdio 映射；
 * 调用方必须保活对象直到实际 CLI 退出及最终日志校验完成，再明确关闭，不能仅保存整数。read 不移动共享文件偏移，
 * 仍核实际文件 owner、模式、单链接和有界长度。close 幂等，错误后也不再拥有原描述符，因此不能自动重试关闭数字。
 */
export interface DarwinPrivateFile {
    readonly fd: number;
    read(limit: number): Buffer;
    close(): void;
}

/**
 * 有界枚举返回完整观察到的有限名字和独立 overflow 标记，未识别成员不能被过滤为安全空目录；每次使用独立原生游标并以不跟
 * 随链接的元数据检查拒绝非普通或不私有的条目。limit 零仍观察第一项，因此 empty
 * 不会被空返回数组误导。正式调用者在这些名字上继续执行自己的用途语法及扫描数量限制。
 */
export interface DarwinPrivateEntries {
    names: string[];
    overflow: boolean;
}

/**
 * 目录会话持有从根逐级无链接打开的真实目录描述符，路径重命名不改变后续成员操作锚点；replace 单独接收已有成员限额，
 * 新正文始终另受原生两兆上限，不放宽 local-secrets 等较小配置。createExclusive
 * 的文件和父目录刷新成功后才交付拥有者，重复名字不会覆盖。remove/replace 发布后的必要刷新或关闭失败返回
 * COMMIT_UNCONFIRMED，由业务层保持恢复语义。close 仅关闭目录自身，已交付 File
 * 继续由其独立拥有者负责。
 */
export interface DarwinPrivateDirectory {
    read(name: string, limit: number): Buffer;
    entries(limit: number): DarwinPrivateEntries;
    createExclusive(name: string): DarwinPrivateFile;
    replace(name: string, temporary: string, bytes: Buffer, existingLimit: number): void;
    remove(name: string, limit: number): void;
    close(): void;
}

/**
 * 原生入口只允许绝对路径与显式创建布尔值，目录链校验和最终 owner/七百模式在实际描述符上执行；只读打开不创建、不
 * realpath、不修权限，缺失之外的任何拒绝都不能解释为没有历史。该接口只提供文件能力，
 * 不签发安装发行能力或进程停止证明。公开函数类型用于约束正式消费者与独立测试，不向调用方暴露原始目录 fd。
 */
export interface DarwinNative {
    openPrivateDirectory(path: string, create: boolean): DarwinPrivateDirectory;
    /**
     * Cookie 元数据入口只接受 Partitions/veriq-host 及其 Network 子目录的四个精确成员，六十四兆额度不扩大普通读取；
     * 退休后刷新或关闭失败保留 COMMIT_UNCONFIRMED，
     * 返回缺失不证明先前持久提交或物理擦除。false 仅检查实际元数据，true 退休已验证成员，两者都不读取正文或交付原始描述
     * 符。
     */
    privateCookieFile(path: string, retire: boolean): boolean;
    /**
     * 报告退休只核验并删除固定 offline/work/Attempt/evidence 下同一普通文件，大小与 SHA256 在原生流式核对；
     * 缓存库存退休先隔离专用 UUID 命名空间后才改变只读属性，未知成员或关闭失败
     * 保持错误，不扩大凭据读取能力。
     */
    retirePrivateEvidence(path: string, file: { path: string; sizeBytes: number; sha256: string }): void;
    /**
     * 有限库存必须由宿主信任校验产生且本机 SQLite 已提交退休意图，原生只允许 bundles/UUID 到对应退休名的隔离与清单成员
     * 删除；单次最大四千零九十八文件及一百二十八 MiB，不能删除引擎、凭据或未知源目录。
     */
    retirePrivateInventory(
        directory: string,
        original: string,
        retiring: string,
        files: { path: string; sizeBytes: number; sha256: string }[],
    ): void;
}
let loaded: DarwinNative | undefined;
let installedPath: string | undefined;
let loadedPath: string | undefined;

/**
 * 安装角色与 Electron 主进程只能绑定完整 Mac 库存解析器颁发的有限原生能力，已有开发模块或不同发行的模块不能被静默置换；
 * 标准加载器仍实际检查 MachO 与 NodeAPI，失败时不寻找备用模块或读取私有业务文件。
 * 宿主应先检查自身应用身份与签名，再将经过独立期望值核验的发行对象传入此函数。
 */
export function bindDarwinDistribution(distribution: RuntimeDistribution): void {
    if (process.platform !== "darwin") throw new Error("DARWIN_NATIVE_PLATFORM_REQUIRED");
    const path = verifiedNativeAddon(distribution);
    if ((installedPath && installedPath !== path) || (loadedPath && loadedPath !== path))
        throw new Error("DARWIN_NATIVE_BINDING_CHANGED");
    installedPath = path;
    darwinNative();
}

/**
 * 开发装载只接受普通 Node 宿主和固定源码相邻的 Darwin 产物位置，安装角色使用同一进程内原始库存对象绑定的独立路径；
 * veriq 角色或 Electron 等其他宿主缺少可信能力时明确拒绝，不能读取开发副本冒充已安装验收。
 * Darwin 产物使用独立目录及名称，避免覆盖 Windows 已有库存身份。Node 标准加载器会验证实际 Mach-O/ABI，
 * 装载失败原样传播且不另寻替代路径。缓存只在真实加载成功后写入，不把缺失模块变成空能力或文件路径后备。
 */
export function darwinNative(): DarwinNative {
    if (process.platform !== "darwin") throw new Error("DARWIN_NATIVE_PLATFORM_REQUIRED");
    if (!installedPath && basename(process.execPath) !== "node") throw new Error("DARWIN_NATIVE_DISTRIBUTION_REQUIRED");
    if (!loaded) {
        const path =
            installedPath ?? fileURLToPath(new URL("../../build/darwin/veriq_private_files.node", import.meta.url));
        loaded = createRequire(import.meta.url)(path) as DarwinNative;
        loadedPath = path;
    }
    return loaded;
}
