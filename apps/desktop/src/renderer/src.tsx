import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { installDesktopTransport } from "./adapters";
import { App } from "./App";
import "@veriq/web/desktop.css";
import "./style.css";

/** 桌面入口先安装受限宿主传输再挂载共享业务视图，查询缓存属于本窗口并禁止隐式写操作重试；静态 CSS 和 worker 都由打包产物提供，页面启动不依赖控制平台在线。 */
installDesktopTransport();
const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 }, mutations: { retry: false } },
});
createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
        <QueryClientProvider client={client}>
            <App />
        </QueryClientProvider>
    </React.StrictMode>,
);
