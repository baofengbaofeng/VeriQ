/** 桌面端到端测试从本工作区已经锁定的 Playwright 包取得驱动，根 tests 目录不依赖偶然提升的 node_modules；真实 Electron 可执行文件与独立 Node 路径由受信测试启动器显式提供。 */
export { test, expect, _electron, chromium } from "@playwright/test";
