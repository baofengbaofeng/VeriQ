/** 本机环境覆盖仅允许既有 Runtime 支持的三个公开路由字段，不接受身份、令牌、请求头或执行参数；宿主确认后只对当前启动生效，原签名快照保持只读并由 Runtime 记录 dirty 与实际环境。 */
export type RoutingOverride = { baseURL?: string; apiBaseURL?: string; fixtureBaseURL?: string };

/** 本次执行的路由覆盖是既有 Runtime 环境参数的有限投影，允许用户把签名用例送往明确确认的业务环境；它不会改变资源版本、发行库存、设备控制 Origin 或任何离线包的签名字节。
 * 输入必须是对象，数组不能被当成带数字键的配置接受。
 * baseURL 只影响用例导航的业务基地址。
 * apiBaseURL 只影响该执行的业务 API 基地址。
 * fixtureBaseURL 只影响既有夹具协议使用的基地址。
 * 三个字段之外的属性立即拒绝，包括 headers、token 和 executable。
 * 值必须是有限长度的 URL 字符串，避免原生确认框承载无界文本。
 * URL 构造器负责标准化和解析，调用方不使用手写主机拆分规则。
 * HTTP 和 HTTPS 是业务测试支持的协议，不允许 file、javascript 或自定义处理器。
 * userinfo 会把秘密放进可见 URL，因此即使 URL 合法也需要拒绝。
 * fragment 不会发给服务端，保留它只会造成确认内容与实际请求不一致。
 * 路径可以保留，因为业务 API 可能部署在固定的非根路径。
 * 输出只包含经校验字段，原始对象的原型与多余成员不被转发。
 * 宿主和独立后台都调用此函数，各自建立边界而不信任前一层已经检查。
 * 最终发送凭证前的用户确认在主进程，Runtime 负责记录 dirty 和实际环境。
 */
export function routingOverride(input: unknown): RoutingOverride {
    if (!input || typeof input !== "object" || Array.isArray(input))
        throw new Error("ROUTING_OVERRIDE_INVALID");
    const output: RoutingOverride = {};
    for (const [key, value] of Object.entries(input)) {
        if (
            !["baseURL", "apiBaseURL", "fixtureBaseURL"].includes(key) ||
            typeof value !== "string" ||
            value.length > 2048
        )
            throw new Error("ROUTING_OVERRIDE_INVALID");
        const url = new URL(value);
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash)
            throw new Error("ROUTING_OVERRIDE_INVALID");
        output[key as keyof RoutingOverride] = url.href;
    }
    return output;
}
