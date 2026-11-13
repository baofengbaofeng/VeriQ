/** 官方 Trace 服务的随机前缀是一项仅在后台与主进程之间流转的私有入口，主进程必须先检查完整地址形态才创建窗口；不能把任意监听日志、普通链接或 renderer 字符串当作查看器能力。
 * 只接受 IPv4 loopback，避免 localhost 名称解析和其它网卡地址扩大监听范围。
 * 必须显式携带随机服务端口，默认 HTTP 端口不属于该后台查看器。
 * 不允许用户名和密码，URL 不承担平台认证或凭证转送。
 * 路径含三十二位随机十六进制前缀，裸根路径不是合法查看入口。
 * 只有官方 trace/index.html 页面可作为首次入口，不能传其它工具页面。
 * 查询部分由官方 traceViewerPath 生成，包含私有单 Trace 副本的引用。
 * 返回 origin 供 Session 请求检查使用，不把私有完整 URL 交回业务 renderer。
 * 后续文件读取还受后台 allowedFileRoots 限制，origin 检查不能替代目录隔离。
 */
export function ownedTraceOrigin(value: string): string {
    const url = new URL(value);
    if (
        url.protocol !== "http:" ||
        url.hostname !== "127.0.0.1" ||
        !url.port ||
        url.username ||
        url.password ||
        !/^\/[0-9a-f]{32}\/trace\/index\.html$/.test(url.pathname)
    )
        throw new Error("TRACE_ORIGIN_DENIED");
    return url.origin;
}

/** 快照文档需要少量浏览器内部 URL，但这些例外只属于隔离 Trace Session；普通应用的 CSP 与网络白名单完全不因此改变，且快照页面不能借重放内容联系原业务服务或其它互联网来源。
 * 同一 origin 比较包含端口，因此同主机另一个进程仍不在白名单内。
 * blob 地址必须继承该查看器 origin，不能借其它来源的 blob 绕过限制。
 * 官方空白快照使用 base64 HTML 子框架，仅放行这一精确资源类型与前缀。
 * data 主框架不在例外内，不能把应用导航到携带脚本的任意文档。
 * 普通 fetch、图片和脚本请求不能借用 subFrame 例外。
 * 该判定由主进程的真实 webRequest 资源类型驱动，不读取页面自报类型。
 * 窗口权限处理器仍全部拒绝，网络允许并不授予摄像头、剪贴板等系统权限。
 */
export function allowedTraceRequest(value: string, resourceType: string, origin: string): boolean {
    const url = new URL(value);
    return (
        url.origin === origin ||
        value.startsWith(`blob:${origin}/`) ||
        (resourceType === "subFrame" && value.startsWith("data:text/html;base64,"))
    );
}
