/** 本脚本只作为真实生产静态集成测试的浏览器驱动，连接 Python 测试启动的 HTTPS 应用并使用实际 Vite 产物；不启动 Vite、不替换鉴权，也不为控制服务增加 Node 运行时依赖。
 * HTTPS 证书由测试临时生成，因此浏览器只在这个独立上下文忽略证书信任错误。
 * Secure Cookie、SameSite 与同源 CSRF 仍按真实浏览器规则执行。
 * 账号来自隔离测试库初始化，不读取或输出私有部署配置。
 */
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";

// 目标 origin 由 Python 测试绑定随机 HTTPS 端口后传入，脚本只接受这个测试实例的完整源；没有硬编码真实平台地址，也不会读取设备或正式发布凭据。
// 固定账号已经在专用测试数据库创建。
// 浏览器退出由 finally 负责，断言失败也不会遗留测试进程。
const origin = process.argv[2];
const browser = await chromium.launch({
    executablePath: process.env.VERIQ_TEST_CHROMIUM,
});
try {
    // 独立上下文仅忽略临时测试证书的信任链错误，页面仍通过 HTTPS 加载并执行真实 Cookie 安全规则；这不是关闭 Origin 校验或将正式配置降级为开发模式。
    // 与开发代理测试不同，此处没有 Vite 服务。
    // 每个脚本实例从空 Cookie 存储开始，不能借用此前登录状态。
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    // 直接访问登记登录路径验证服务器深链接入口，之后等待实际前端与会话探测完成再填写表单；不向页面注入假用户、模拟路由或拦截 API 响应。
    // 表单动作使用现有稳定 testId。
    // 自动等待来自 Playwright 的可见性断言，不添加固定延时。
    await page.goto(`${origin}/login`);
    await expect(page.getByRole("heading", { name: "Sign in to VeriQ" })).toBeVisible();
    await page.getByTestId("email").fill("admin@example.com");
    await page.getByTestId("password").fill("Long password 123!");
    await page.getByTestId("login-submit").click();
    await expect(page.getByTestId("account-info")).toBeVisible();
    // 登录成功后核对浏览器实际保存的会话 Cookie，Secure、HttpOnly 和 Strict 必须同时保留；仅从 HTTP 响应字符串读取标志不足以证明真实页面能够使用该会话。
    // 不输出 Cookie 值或完整 Cookie 对象。
    // 临时证书只影响信任检查，不影响这些 Cookie 属性。
    const cookies = await context.cookies();
    const session = cookies.find((cookie) => cookie.name === "veriq_session");
    assert.ok(session?.secure && session.httpOnly && session.sameSite === "Strict");
    // 完整导航再刷新执行计划路径，使第二次加载真正经过生产 Tornado 而非单纯客户端导航；页面可见性同时证明入口、JS、CSS 和已认证 API 能在同一源配合运行。
    // 无 Workspace 时仍应显示计划页面的实际空状态。
    // 不创建计划、执行任务或调用外部服务。
    await page.goto(`${origin}/execution-plans`);
    await page.reload();
    await expect(page.getByRole("heading", { name: "执行计划 / Execution plans" })).toBeVisible();
    // 用同一浏览器上下文请求入口并核对 no-cache，避免页面从前次客户端状态看似成功；服务必须为每次刷新保留重新验证入口的语义。
    // 入口请求不是对任意未知路径放行。
    // 后面的错误矩阵专门检查 fallback 边界。
    const entry = await context.request.get(`${origin}/execution-plans`);
    assert.equal(entry.status(), 200);
    assert.equal(entry.headers()["cache-control"], "no-cache");
    // 未知公开接口、内部接口、缺失脚本和未知页面分别请求，Accept 为 HTML 也必须返回真实 JSON 404；这防止前端入口掩盖 API 拼写或资源发布错误。
    // 本上下文已经登录，错误不能仅靠匿名权限拒绝来通过。
    // 每个请求独立检查状态与 Content-Type。
    for (const path of [
        "/api/v1/missing",
        "/internal/v1/missing",
        "/assets/missing.js",
        "/unknown-page",
    ]) {
        const response = await context.request.get(`${origin}${path}`, {
            headers: { Accept: "text/html" },
        });
        assert.equal(response.status(), 404);
        assert.ok(response.headers()["content-type"].startsWith("application/json"));
    }
    // 脚本 URL 取自实际 Vite 输出的页面而非预设测试文件名，检查真正随本次构建发布的内容指纹资源；文件字节仍由同一个生产端口提供。
    // 长期缓存只应用于带指纹的 assets。
    // 不使用 Vite 开发脚本或浏览器网络响应 mock。
    const asset = await page.locator('script[type="module"]').getAttribute("src");
    const script = await context.request.get(`${origin}${asset}`);
    assert.equal(script.status(), 200);
    assert.equal(script.headers()["cache-control"], "public, max-age=31536000, immutable");
    // 使用真实已登录 Cookie 发起缺少 CSRF 头的退出请求，即使 Origin 正确也必须拒绝；生产静态加入不能削弱既有浏览器写操作保护。
    // 不执行成功退出以保持后续诊断可观察的会话状态。
    // 这里断言安全边界，不把脚本 404 当作权限验证。
    const denied = await context.request.post(`${origin}/api/v1/auth/logout`, {
        headers: { Origin: origin },
        data: {},
    });
    assert.equal(denied.status(), 403);
    await context.close();
    // 诊断只输出固定英文结论，不包含 URL 参数、凭据或数据库配置；Python 测试仅在子进程失败时显示捕获的断言错误，便于明确区分环境故障和产品行为失败。
    // 成功输出不代表 wheel 或无 Node 发行验收。
    // 脚本只证明本次真实前端与生产 HTTPS 应用的组合行为。
    console.log("Production HTTPS login, deep refresh, JSON 404, cache and CSRF checks passed");
} finally {
    await browser.close();
}
