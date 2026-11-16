/**
 * GUI 清单类型只表达普通文件的精确字节事实与整个规范序列化摘要，不包含批准状态或任意读取接口；运行版本由同名 MJS 实际
 * 扫描生成，TypeScript 消费者不能凭此声明把自报对象提升成受信输入。
 */
export interface DesktopGuiInventory {
    bytes: Buffer;
    sha256: string;
    files: { path: string; sizeBytes: number; sha256: string }[];
}
/**
 * 扫描范围固定为调用者选定的真实 GUI 输出根，入口存在、全资源覆盖及链接拒绝均由运行实现执行；返回摘要只供独立期望比较
 * ，签名与来源审批必须由外层明确完成，不能从类型推断已验证。
 */
export function desktopInventory(directory: string): Promise<DesktopGuiInventory>;
