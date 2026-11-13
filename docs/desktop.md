# VeriQ 桌面工作台 / Desktop workspace

桌面窗口、独立 Node24 后台与业务测试浏览器各自运行。窗口使用随包的 React 页面，可以在控制平台断网时打开已下载资源和历史；联网编辑、AI 配置与云端证据仍要求当前平台权限。安装包制作、系统凭证库及 Windows / Ubuntu 原生安装验收属于后续发行门禁，当前源码构建不代表已发布安装包。

The bundled Electron UI remains available without the control platform. Its independent Node24 Agent runs signed packages and retains history. Online editing, AI configuration and cloud evidence require current platform permissions. Installer production, the system credential vault and target-OS acceptance remain release gates; a source build is not an installer release.

## 使用流程 / Workflow

1. 在“设置与诊断”配置控制平台 Origin。正式平台使用 HTTPS；本机开发可使用 HTTP loopback。代理仅接受无凭证的 HTTP(S) 地址。系统信任库负责证书校验，界面不提供忽略 TLS 错误的开关。
2. 用普通账户登录并选择 Workspace。普通登录与设备绑定相互独立；登录退出不会撤销设备。绑定时核对设备码，明确选择是否共享给工作区，并由有权限的成员批准。
3. 联网资源页支持图形表单、JSON、草稿保存、编译校验、发布、版本差异和实际生成源码。校验排队不代表通过；发布需要对应成功回执。AI 页面用于配置、预览和审核，离线执行不会调用模型。
4. 下载资源包后由后台验签。进入“本机缓存”选择资源包，配置它钉选的凭证引用。凭证只可写入或移除，不能从界面读回。环境覆盖仅作用于当前执行，必须原生确认并在结果中标记为非原始环境。
5. 启动独立执行；可选择一次整用例重试。可见浏览器选项仅在安装了精确匹配的完整浏览器时可用，headless shell 不提供此能力。准备阶段可取消本次启动，运行后可取消当前 Run；结果以后台持久化的执行和停止事实为准。
6. 报告页展示步骤、断言、事件、制品及门禁原因。离线导入不自动成为正式门禁通过。原始证据保存、截图与 Trace 需要宿主确认；Trace 使用隔离的原生窗口。
7. 平台恢复后显式回传。失败保留 `PENDING` 与错误，成功为 `COMPLETE`；重复回传复用持久回执。恢复流程使用设备登记的控制 Origin，不使用包中的业务地址作为回传目的地。

Configure the server, sign in, select a Workspace, enroll the independent device, and download a verified package. Map only the package's pinned credentials, then run from Local cache. Reports and generated source remain local when disconnected. Retry uploads explicitly after connectivity returns; `COMPLETE` means an import receipt was persisted. Visible mode requires the matching full Chromium distribution.

## 生命周期 / Lifecycle

| 操作 / Action                          | 结果 / Result                                                                                             |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 关闭或收起窗口 / Close or minimize     | 有托盘支持时隐藏到托盘，否则保留最小化窗口；后台继续 / Agent continues                                    |
| 退出界面 / Quit UI                     | 原生确认后退出 Electron；活动 Agent 继续 / Confirmed UI exit keeps Agent alive                            |
| 取消启动 / Cancel startup              | 只取消界面显示的本次准备事务，不生成虚构 Run / Cancels the identified preparation without inventing a Run |
| 取消执行 / Cancel run                  | 请求取消当前 Run，等待真实停止事实 / Requests cancellation and records stop facts                         |
| 停止后台 / Stop Agent                  | 原生确认后取消活动工作并关闭后台 / Cancels active work and closes Agent                                   |
| UI 崩溃、重新打开 / UI crash or reopen | 重连同一私有档案及后台 / Reconnects to the same profile and Agent                                         |

GNOME 环境不能假设系统提供托盘，界面会说明最小化回退。托盘菜单包含恢复窗口和确认退出。目标操作系统的图标、进程名、安装/卸载和更新回滚仍需原生发行验收。

## 开发构建 / Source build

需要锁定 Node24.22.1、pnpm11.25.0、Electron45.3.1 与 Playwright1.65.0 的匹配测试浏览器。Electron 内嵌 Node 和 Chromium 仅服务 UI，不能替代独立执行引擎。桌面最终分发需要完整携带运行依赖，不能依赖开发工作区。

```sh
pnpm --filter @veriq/desktop build
pnpm --filter @veriq/desktop check
pnpm --filter @veriq/desktop test:unit
```

`check` 会先用 Web 自身兼容配置生成共享声明，再以桌面严格配置检查 host 与 renderer，干净检出不需要预存 `dist-desktop`。`build` 另外生成实际 JS、样式与 worker；类型检查通过不能代替离线窗口资源验收。

The desktop check generates shared Web declarations before checking both strict desktop layers. A clean checkout needs no pre-existing `dist-desktop`; the build additionally creates executable assets.

可信开发启动器设置以下路径后运行 Electron 的 `apps/desktop` 入口；这些值不能通过 renderer 修改：

| 环境变量 / Variable            | 用途 / Purpose                                            |
| ------------------------------ | --------------------------------------------------------- |
| `VERIQ_DESKTOP_PROFILE`        | 私有本机档案 / Private local profile                      |
| `VERIQ_DESKTOP_NODE`           | 独立 Node24.22.1 可执行文件 / Independent Node executable |
| `VERIQ_DESKTOP_ENGINE`         | 已核验引擎发行目录 / Verified engine distribution         |
| `VERIQ_DESKTOP_ENGINE_VERSION` | 对应发行版本，默认 `1.0.0` / Matching engine version      |
| `VERIQ_DESKTOP_BROWSER`        | Playwright 匹配浏览器 / Matched test browser              |
| `VERIQ_DESKTOP_HEADED_BROWSER` | 可选完整可见 Chromium / Optional matched headed Chromium  |
| `VERIQ_TEST_ELECTRON`          | GUI E2E 使用的真实 Electron / Actual E2E executable       |

`pnpm desktop:test` 顺序执行真实冷窗口、生产候选工作流、断网报告及生命周期、离线源码和联网编辑器验收；测试不自动重试。测试需要隔离的 MySQL 测试配置、实际已核验引擎候选、匹配浏览器、桌面显示和可用 Chromium sandbox。所有数据库夹具共用 `/tmp/veriq-t12-db.lock`。缺少这些条件不是产品失败，也不能当作验收通过。测试状态和证据均为私有本机文件，不提交仓库。

The GUI suite uses a real Electron process with Chromium sandbox explicitly enabled, an isolated platform fixture and the production engine candidate. It does not substitute mocked pages or fabricated reports. The fixture's issuer and credentials are synthetic; no paid model provider is needed.

## 干净检出的 GUI 验收 / Fresh-checkout GUI acceptance

[Desktop focused verification](../.github/workflows/desktop-fix-validation.yml) 固定 Ubuntu24.04、Node24.22.1、Python3.12.14、MySQL8.4.13、锁定依赖及匹配浏览器；开发分支 push 自动运行。工作流只创建隔离测试发行与数据库，不发布安装包。生产器输出的 `1.0.2-t19-fix1` 是未批准的测试候选，夹具只在本轮私有签发者下通过正式 `promote_engine` 验证并晋升它。

The focused branch workflow contains the complete fresh-checkout setup, exact action/image pins and artifact allowlist. Its separate candidate is only approved inside the isolated test fixture; it is not a released engine.

本机复现需先按该工作流准备锁定依赖、专用 `veriq_test` 数据库与私有 `.superpowers/sdd/veriq-1/test-env.json`（`mysql_dsn` 字段），然后在仓库根目录执行以下命令。输出目录必须全新，不能覆盖原候选；`PLAYWRIGHT_BROWSERS_PATH` 指向当前工作区缓存。

```sh
export PLAYWRIGHT_BROWSERS_PATH="$PWD/.superpowers/cache/playwright"
mkdir -p work
pnpm --filter @veriq/runner-sdk exec playwright install --with-deps chromium
pnpm --filter @veriq/contracts exec tsx ../../scripts/build_engine.mts 1.0.2-t19-fix1 "$PWD/work/t19-fix1-ci-engine" > work/t19-fix1-engine-production.json
export VERIQ_TEST_ENGINE_DIRECTORY="$PWD/work/t19-fix1-ci-engine"
export VERIQ_TEST_ENGINE_VERSION=1.0.2-t19-fix1
export VERIQ_TEST_ENGINE_HASH="$(python -c 'import json; print(json.loads(open("work/t19-fix1-engine-production.json").read().splitlines()[-1])["inventoryHash"])')"
export VERIQ_DESKTOP_EVIDENCE="$PWD/.superpowers/sdd/veriq-1/evidence/t19/fix1/local"
pnpm --filter @veriq/desktop build
xvfb-run -a -s '-screen 0 1280x800x24 -nolisten tcp' pnpm --filter @veriq/desktop exec node <<'JS'
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
function binary(value) {
    if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error('INVALID_TEST_BINARY_PATH');
    const actual = fs.realpathSync(value);
    if (Array.from(actual).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw new Error('INVALID_TEST_BINARY_PATH');
    if (!fs.statSync(actual).isFile()) throw new Error('TEST_BINARY_NOT_FILE');
    fs.accessSync(actual, fs.constants.X_OK);
    return actual;
}
const result = spawnSync('pnpm', ['test:e2e'], {
    shell: false,
    stdio: 'inherit',
    env: {
        ...process.env,
        VERIQ_TEST_ELECTRON: binary(require('electron')),
        VERIQ_TEST_HEADED_BROWSER: binary(require('playwright-core').chromium.executablePath()),
    },
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
JS
```

首次解析 Electron 可能下载缺失二进制并向 stdout 输出诊断；上面的启动器保留这些日志，通过校验后的真实路径直接构造子进程环境，不把依赖 stdout 当作路径或 shell 代码。

The launcher keeps dependency diagnostics on stdout, validates each executable realpath and passes values directly in the child environment with `shell:false`.

三项 `VERIQ_TEST_ENGINE_DIRECTORY` / `VERSION` / `HASH` 必须同时设置；TypeScript 启动器先完整 `loadRelease` 并比对规范条目摘要，Python 夹具再通过真实晋升流程校验。完全不设置时保留原有本机 `work/t18-engine-verified` 的 `1.0.0` / `4ac705…` 身份，干净检出应使用上面的独立生产命令，不依赖旧机器私有候选。设置 `VERIQ_TEST_HEADED_BROWSER` 会在真实 GUI 恢复链勾选可见模式，观察实际业务浏览器窗口及其 worker/guardian/Agent 归属，随后验证停止事实；省略它只运行无头验收，不能据此宣称可见模式已验证。

The three engine variables are an all-or-none trusted test-launch tuple. Full inventory validation and actual server promotion remain mandatory. Supplying the full-browser path enables the real GUI → offline execution → visible-window → stop-observation check; omitting it does not prove headed execution.

当前 Linux 可见执行要求本机 X11 或 XWayland 的 `DISPLAY`（例如 `:99`），可选 `XAUTHORITY` 必须为绝对路径。后台只向可见 worker 传递这两个受限显示字段，不继承任意宿主环境；纯 Wayland 且没有 XWayland 时失败关闭。Electron GUI 明确启用 Chromium sandbox；既有 Runtime 业务浏览器启动参数包含 `--no-sandbox`，两者是不同进程，该已有策略仍需 T20 的目标系统安全默认值验收。

Visible Linux execution currently requires a local X11/XWayland display and optional absolute Xauthority path. The Electron UI sandbox and the existing Runtime business-browser launch policy are recorded separately; target-system distribution acceptance must review the latter.

## 宿主边界 / Host boundary

普通 Cookie / CSRF 保存在独立 Electron Session，设备 token 保存在独立 Node Agent。preload 只公开有限业务操作；主进程再次校验 sender、主 frame、Workspace、模式及大小。renderer 没有 Node、任意 HTTP、文件系统或 spawn。报告流最多四条且按消费拉取；工作区切换和登出撤销旧流。共享 Web 的类型兼容设置仅用于其自身声明构建，桌面各层仍使用严格 TypeScript。

The renderer loads only bundled assets under a strict CSP. Schema validators are generated by the same Ajv definitions at build time, without `unsafe-eval`. Native Trace windows have no preload, platform cookies or application bridge; their loopback origin and private random URL belong to one viewer instance. Closing a viewer reclaims its server and private copy without stopping the Agent or deleting original evidence.
