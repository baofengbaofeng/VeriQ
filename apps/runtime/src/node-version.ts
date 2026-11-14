/** Node 的版本输出只允许规范稳定的二十四主版本三段数字，有限位数防止不受控清单输入膨胀且拒绝前导零、预发布和构建后缀；这只是兼容条件，发行身份仍由完整库存中的具体版本、角色路径与文件摘要共同约束。 */
export function isNode24Version(value: unknown): value is string {
    return (
        typeof value === "string" &&
        /^24\.(?:0|[1-9][0-9]{0,8})\.(?:0|[1-9][0-9]{0,8})(?![\s\S])/.test(value)
    );
}

/** 独立执行进程除了满足稳定 Node24 兼容范围还不能具有 Electron 的进程标识，同一大版本的桌面内嵌引擎不能成为后台执行能力；调用方必须传入实际进程事实，不能把这个兼容判断当成已安装发行的库存或签名认证。 */
export function isIndependentNode24(versions: { node: string; electron?: string }): boolean {
    return !versions.electron && isNode24Version(versions.node);
}
