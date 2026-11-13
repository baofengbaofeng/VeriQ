import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// Vite 的清单保留入口、懒加载 chunk 与依赖资源的实际输出路径，生产控制服务只公开清单资源；开发代理保持浏览器 Origin 和 Cookie 原样传递，CSRF 仍由现有 API 校验。
// 模块图由 Vite 生成，完整文件库存由 T18 stage 阶段生成，二者职责不同。
// 复制的 public 文件与 worker 不一定出现在模块图，生产不能只依赖该图公开文件。
// 单独启动后端时仍可调试 API，开发安装无需提前构建这里的产物。
// 后端 public_url 应配置为浏览器使用的 5173 源，而不是代理目标的 8888 源。
// 不在编译环境注入服务配置或凭证，发布身份由后续打包阶段单独写入构建元数据。
export default defineConfig({
    plugins: [react()],
    // 发布服务校验完整库存之外还检查 Vite 入口和导入引用，因此开启模块图输出并保留默认隐藏路径；此处不生成构建身份，也不把运行配置读取进前端编译环境。
    // .vite/manifest.json 本身参与完整库存，但不作为公开 URL 服务。
    // build-info.json 与 static-manifest.json 在后续发布阶段写入，避免自引用哈希。
    build: { manifest: true },
    server: {
        host: "127.0.0.1",
        // 固定端口与既有浏览器源配置保持一致，端口被占用时明确失败，避免自动漂移导致 Cookie 和 Origin 校验表现为随机故障；开发者需要改端口时同时修改后端 public_url。
        // 严格端口不会修改 API 目标或启用跨源权限。
        port: 5173,
        strictPort: true,
        // 浏览器继续向自身源请求 API 和事件流，代理不重写 Origin 或 Cookie，也不添加宽松 CORS；员工 Cookie 和原生设备受限入口的鉴权差异完全由现有处理器决定。
        // 默认 HTTP 流式转发保留 SSE，当前订阅不需要另建 WebSocket 服务。
        // /internal 代理仅提供可达性，不代表授予其设备或服务令牌权限。
        proxy: {
            "/api": "http://127.0.0.1:8888",
            "/internal": "http://127.0.0.1:8888",
        },
    },
});
