import type { Configuration } from "electron-builder";
import type { DesktopRelease } from "./src/installation/release.ts";

/**
 * 打包配置参数只来自已核验的独立资源根和显式签名决策，声明不提供默认候选路径或自动证书选择；实际 MJS 工厂保留四目标原
 * 生安装器、固定应用身份与独立 Runtime 的 ASAR 外布局。
 */
export function desktopBuilderConfiguration(input: {
    appDirectory: string;
    runtimeDirectory: string;
    releaseFile: string;
    outputDirectory: string;
    release: DesktopRelease;
    signing: {
        mode: DesktopRelease["signing"]["mode"];
        identity?: string;
        installerIdentity?: string;
    };
}): Configuration;
