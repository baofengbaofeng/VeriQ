import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const deploy = fileURLToPath(new URL("../../deploy/desktop/", import.meta.url));

/** 安装配置只接受入口已经完整核验的暂存路径和明确签名选择，四种目标分开生成且不含任何自动下载业务浏览器步骤；独立 Runtime 原样放在 ASAR 外，Electron 自带 Node 只负责 GUI。
 * 使用 pkg 的安装前脚本拒绝仍运行的产品进程，避免 Finder 覆盖绕过生命周期检查。
 * Windows NSIS 禁止自动关闭应用，Ubuntu deb 同样在包管理脚本拒绝忙碌升级。
 * 签名身份来自操作者显式输入，未选择的模式不会被本机偶然存在的证书自动提升。
 * 不生成自动更新源，也不启用自动发布；后续正式发行仍须全部质量与目标安装验收。
 */
export function desktopBuilderConfiguration({
    appDirectory,
    runtimeDirectory,
    releaseFile,
    outputDirectory,
    release,
    signing,
}) {
    const signed = signing.mode === "NATIVE_SIGNED";
    return {
        /** 固定 Bundle ID、用户产品名与真实小写角色文件名分别表达不同身份，安装器不得随版本或架构改变它们；可执行名也决定 Mac 的技术目录 veriq.app，Finder 显示名称另外由 Info.plist 保
         * 留 VeriQ。
         * artifactName 包含目标 OS 与架构，避免两种 Mac 产物互相覆盖。
         * 版本由受核暂存 package.json 提供，不使用构建机 Electron 或 Node 版本。
         * 资源目录全部是本次调用明确传入的绝对路径。
         * GUI 依赖来自已核 Runtime 的物理副本，不让 collector 读取开发工作区链接。
         */
        appId: "io.github.baofengbaofeng.veriq",
        productName: "VeriQ",
        executableName: "veriq",
        artifactName: "VeriQ-${version}-${os}-${arch}.${ext}",
        directories: { app: appDirectory, output: outputDirectory },
        files: ["out/**/*", "package.json", "node_modules/**/*"],
        /** 独立 Node 无法读取 ASAR 虚拟文件，所以 Agent、Runner、npm、引擎与宿主 Chrome 全部保留在真实资源目录；桌面描述放在 Runtime 外，避免把期望文件加入它自己要授权的库存树。
         * Runtime 树不分拆，不重新选择浏览器，也不创建 Linux 到 Mac 的兼容映射。
         * 完整 Framework 链接由既有 Mac 库存政策决定，复制后仍会全树复验。
         * 业务包、设备档案和本地报告都不会从构建机进入安装资源。
         * 这份描述的真实性最终由原生安装器签名及发布审批保护。
         */
        extraResources: [
            { from: runtimeDirectory, to: "runtime", filter: ["**/*"] },
            { from: releaseFile, to: "desktop-release.json" },
        ],
        /** 固定 Electron 工具版本并显式配置生产 Cookie 加密与宿主注入 fuse，独立业务 Node 不受这些 GUI 二进制开关影响；修改仅发生于 builder 的新副本，不能原位污染共享 pnpm 下载缓
         * 存。
         * runAsNode 关闭后 GUI 壳不能替代 Node24 后台角色。
         * NODE_OPTIONS 和命令行 inspector 无法为安装 GUI 注入额外代码。
         * OnlyLoadAppFromAsar 固定宿主应用入口，不接受旁边的 loose app 覆盖。
         * 支持的平台同时开启 ASAR 完整性验证，Linux 保留完整安装清单与原生包信任。
         * 主进程实际读回 Cookie fuse，再执行 OS 提供者探针。
         * file 协议额外权限关闭，UI 已有 veriq 安全本地协议。
         */
        electronVersion: "45.3.1",
        electronFuses: {
            runAsNode: false,
            enableCookieEncryption: true,
            enableNodeOptionsEnvironmentVariable: false,
            enableNodeCliInspectArguments: false,
            enableEmbeddedAsarIntegrityValidation: release.platform !== "linux",
            onlyLoadAppFromAsar: true,
            grantFileProtocolExtraPrivileges: false,
        },
        asar: true,
        asarUnpack: ["**/*.node"],
        /** 依赖已由 Runtime 生产器固定并经完整库存核验，builder 不能另行安装或按 Electron 宿主重编目标原生模块；关闭默认 package.json 清理还保留原始包元数据，便于后续将加载路径与原库存逐
         * 项比较。
         * beforeBuild 的 false 只跳过 builder 依赖安装，不跳过外层任何库存或发布门禁。
         * npmRebuild 与 nodeGypRebuild 都关闭，安装包不要求用户机器有编译器。
         * 不启用差量自动更新，首版更新始终由用户明确发起。
         * publish 为 null 且调用端 publish=never，构建成功也不会自动对外上传。
         */
        beforeBuild: async () => false,
        removePackageScripts: false,
        removePackageKeywords: false,
        npmRebuild: false,
        nodeGypRebuild: false,
        buildDependenciesFromSource: false,
        forceCodeSigning: signed && release.platform !== "linux",
        publish: null,
        compression: "normal",
        /** Mac 两架构分别使用原生 pkg 并固定最低 macOS15，应用签名与安装器签名由两个独立身份明确选择；不自动公证、不申请证书，也不因为本机发现某个证书就改变 unsigned 候选性质。
         * hardenedRuntime 只在发布者签名模式启用，ad-hoc 不伪装成生产发布者。
         * 原始 Runtime 子树已经先签名再封库存，signIgnore 禁止 builder 改写这些字节。
         * afterPack 和 afterSign 再核完整库存，任何签名副作用都会让候选失败。
         * native addon 保持 Node-API ABI，Electron 主进程仍须通过目标加载检查。
         * entitlement 只保留 Electron JIT，不开放任意动态库或应用沙箱绕过。
         * 真实 Cookie、控制台与 Keychain 接受度仍独立于这份配置。
         */
        mac: {
            target: [{ target: "pkg", arch: [release.arch] }],
            category: "public.app-category.developer-tools",
            minimumSystemVersion: "15.0",
            hardenedRuntime: signed,
            identity: signed ? signing.identity : signing.mode === "AD_HOC" ? "-" : null,
            signIgnore: [".*/Contents/Resources/runtime/.*"],
            notarize: false,
            gatekeeperAssess: false,
            entitlements: resolve(deploy, "macos/entitlements.plist"),
            entitlementsInherit: resolve(deploy, "macos/entitlements.plist"),
            extendInfo: { CFBundleDisplayName: "VeriQ", LSMinimumSystemVersion: "15.0" },
        },
        /** pkg 的安装前脚本只拒绝活动角色而绝不强杀进程，固定系统安装位置使应用身份与资源根可重复核验；人工回滚依赖签名清单的明确来源版本和相同数据格式，不能被默认版本检查提前阻断。
         * isVersionChecked=false 只允许系统包管理流程安装旧版本，不授权 GUI 自动降级。
         * GUI 回滚仍必须验签、匹配当前版本和引擎，并取得持续空闲证明。
         * 不允许安装到任意卷或当前用户 Home，避免同一 Bundle ID 出现多个资源副本。
         * 安装脚本从本仓库固定路径取得，不能由候选配方提供任意脚本。
         * 用户档案位于应用外，安装与回滚都不删除历史数据。
         */
        pkg: {
            scripts: resolve(deploy, "macos/scripts"),
            installLocation: "/Applications",
            identity: signed ? signing.installerIdentity : null,
            isRelocatable: false,
            isVersionChecked: false,
            allowAnywhere: false,
            allowCurrentUserHome: false,
            allowRootDirectory: true,
        },
        /** Windows 使用固定 x64 NSIS 和显式 Authenticode 证书主体，安装器包含产品角色忙碌检查并替换框架默认的关闭应用动作；unknown 查询错误同样拒绝，不能因无法枚举进程就放行升级。
         * 默认按用户安装，不需要桌面自身接管机器级服务。
         * 安装目录不由 renderer 或业务包提供。
         * 卸载默认保留 appData，秘密退役由独立明确流程负责。
         * runAfterFinish 关闭，避免未完成目标验收时自动触发凭据或浏览器操作。
         * differentialPackage 关闭，因为完整人工签名升级尚未授权自动差量协议。
         */
        win: {
            target: [{ target: "nsis", arch: ["x64"] }],
            signAndEditExecutable: signed,
            ...(signed
                ? {
                      signtoolOptions: {
                          certificateSubjectName: signing.identity,
                          publisherName: signing.identity,
                      },
                  }
                : {}),
        },
        nsis: {
            oneClick: false,
            perMachine: false,
            allowToChangeInstallationDirectory: false,
            deleteAppDataOnUninstall: false,
            runAfterFinish: false,
            include: resolve(deploy, "windows/installer.nsh"),
            differentialPackage: false,
        },
        /** Ubuntu 交付原生 x64 deb 并声明真实系统运行库，测试 Chrome 使用包管理器固定 root-owned 路径的 AppArmor 用户命名空间策略；不搬运构建宿主系统库，也不修改全局沙箱限制。
         * GUI 和业务 Chrome 分别有精确路径政策，没有任意可写路径通配。
         * 默认 electron-builder 安装后脚本负责部署该应用局部政策。
         * 安装与卸载前脚本先拒绝仍运行的自有角色，用户数据不会被清空。
         * 系统库列表是安装前提，仍须在干净 Ubuntu24.04 验证完整离网闭包。
         * Linux 发布者真实性由独立签名清单或包仓库认证，不能冒充 Mac/Windows 原生签名。
         */
        linux: {
            target: [{ target: "deb", arch: ["x64"] }],
            category: "Development",
            executableName: "veriq",
            maintainer: "VeriQ contributors",
            appArmorProfile: resolve(deploy, "linux/apparmor-profile.tpl"),
            desktop: { entry: { Name: "VeriQ", StartupWMClass: "VeriQ", Terminal: "false" } },
        },
        deb: {
            beforeInstall: resolve(deploy, "linux/before-install.sh"),
            beforeRemove: resolve(deploy, "linux/before-remove.sh"),
            depends: [
                "libgtk-3-0",
                "libnss3",
                "libsecret-1-0",
                "libgbm1",
                "libasound2t64",
                "libxss1",
                "libxtst6",
                "libatspi2.0-0",
                "libdrm2",
                "libxkbcommon0",
                "libx11-xcb1",
                "libxdamage1",
                "libxrandr2",
            ],
        },
    };
}
