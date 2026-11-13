# 服务端候选、验证与安装

`./build.sh` 是正常发行入口；`--with-tests` 与默认相同。`--skip-tests --reason "incident reference"` 只跳过动态测试，仍执行类型、lint、格式、注释、静态库存、wheel 和干净安装检查。常规 CI 拒绝 `testsSkipped=true`。当前历史格式与 B05 注释债由 T22 整改；门禁失败时没有正常成功发行，独立验证的候选也不能冒充已发布版本。

固定工具为 Python3.12.14、uv0.13.5、Node24.22.1、pnpm11.25.0。构建执行 frozen 安装、Web tsc/Biome/Prettier、Vite、完整文件暂存、Python 与核心 TS 覆盖率至少75%、真实 MySQL/浏览器测试、Hatch wheel 和仓库外离线安装。测试使用独立 `veriq_test` 与同一 `/tmp/veriq-t12-db.lock`，私有 `.superpowers/sdd/veriq-1/test-env.json` 由开发者或 CI 安全提供，不提交凭证。缺条件失败。

正常裸包在 Ubuntu24.04 x64/Python3.12 上制作并实际安装验证。Debian 开发机的候选验证不代替目标 OS 验收。Dockerfile 使用固定 Python 镜像摘要，容器另行启动验证。服务镜像只含 Python 控制面，不含 Node 或浏览器。部署需要外部 HTTPS 终结代理；仅向本机暴露8888，配置 `public_url` 为实际 HTTPS 源。

每次构建的命令、时间、退出码和源码映射保存在 `work/release-*`。产物先放候选目录，通过后移到不可变 `output/server-<buildId>`，最后原子切换 `output/server`。旧输出不被构建器删除。对正在构建的源码进行修改会使最终身份复核失败。正式 wheel 包含完整 `static/dist`、迁移、合同、许可、示例配置和候选引擎库存；editable 无需先构建前端。sdist 携带同一资源，可以在没有 `.git` 的目录重建。

## 引擎身份与显式晋升

产品版本0.1.0、编译器0.1.0、SDK0.1.0与候选引擎1.0.0是不同维度。`pnpm --filter @veriq/contracts exec tsx ../../scripts/build_engine.mts 1.0.0 <新的work目录>` 编译真实源码、归档冻结依赖并生成 npm 锁及库存。它不访问签发者，不代表批准。目录禁止覆盖；此前批准的0.1.0字节及版本必须保留。

部署操作员先把候选完整文件安装到目标 Runtime，再使用已配置的签发者与批准清单执行：

```sh
/opt/veriq/venv/bin/python -m veriq_server.promote_engine \
    --config /etc/veriq/veriq.json --candidate /opt/veriq/engines/1.0.0
```

第一次配置先以0600文件准备 `{"schemaVersion":"1.0","engines":[]}`。晋升复用 `authority_guard`，先 issuer `.lock` 再 issuer `.inventory.lock`，在锁内复核当前批准内容并 fsync 原子替换。锁必须位于可写 issuer 状态目录，不能要求在只读 wheel 旁写锁。相同版本的不同库存身份拒绝；旧版本保留。晋升不会修改配置选择或重新发布资源。

成功晋升后，才将外置配置 `validation_engine_version` 切为1.0.0并重启控制服务；默认0.1.0保持已有开发行为。新快照 sourceHash 改变，旧预览提交冲突；已冻结 Job、回执和签名包继续使用旧版本。未批准版本不能形成有效正式发布回执；原有 UNVALIDATED_DEBUG 的只读 DSL 工作流不受影响。

## 离线安装、迁移与回滚

先验证下载的 `sha256sums`，保留可信来源渠道。归档中包含 wheelhouse、部署脚本、NOTICE、SBOM与release.json。安装器不覆盖已有目录：

```sh
tar -xzf veriq-server-0.1.0-linux-x64.tar.gz -C /opt/veriq/releases/candidate
/opt/veriq/releases/candidate/deploy/install.sh /opt/veriq/venv-0.1.0
/opt/veriq/venv-0.1.0/bin/python -m veriq_server --config /etc/veriq/veriq.json init
/opt/veriq/venv-0.1.0/bin/python -m veriq_server --config /etc/veriq/veriq.json create-admin --email admin@example.com --display-name Administrator
/opt/veriq/releases/candidate/deploy/start.sh /opt/veriq/venv-0.1.0 /etc/veriq/veriq.json
```

`init` 在新配置时交互读取 MySQL 地址并生成外置密钥；示例文件没有真实密钥，不能直接启动。数据库、主密钥、签名密钥与签发者备份必须在升级前完成。配置、issuer、批准库存、制品都放包目录外。容器中的 issuer 文件位于 `/var/lib/veriq/issuer`，允许写锁；配置目录只读挂载。不要将私钥加入镜像或 CI。

升级时停写并备份数据库与制品，使用新 venv 单独运行 `python -m veriq_server --config ... migrate`，检查健康与迁移版本，再切换服务。每个 API 副本启动时不自动迁移。仅在 Schema 向后兼容时切回旧 venv；否则恢复配套数据库/制品/密钥备份或向前修复。旧二进制回滚不能逆转数据库迁移，不能自动 downgrade。

## 检查方法与限制

`scripts/comment_audit.py --output work/comment-audit.json` 公开固定计数法及仅两个生成合同文件排除项；Python AST/tokenize 与 TypeScript 解析器定位真实说明，空行不计数。大于40%、中文和首行60字符属于机械门禁，公开 API 的职责、关键不变量和说明有效性仍需独立人工审查。不能用重复政策句或排除旧代码绕过 B05。

Python SBOM来自实际干净安装环境，由CycloneDX生成并验证。前端/引擎依赖另记录冻结锁及供应商许可证；前端捆绑实际范围与开发构建闭包明确区分。真实Provider、目标OS、容器和正式签名/发布必须保留各自证据，本任务开发构建不提供这些操作授权。

# Server candidates, verification and installation

`./build.sh` runs all gates by default. `--with-tests` is an alias. Emergency `--skip-tests --reason ...` retains static, integrity and installation checks and is rejected by normal CI. Existing formatting/comment debt remains a real release blocker until T22 resolves it.

The pipeline binds the commit, exact source bytes, locks and full static inventory. A successful candidate becomes an immutable directory before `output/server` is atomically switched; failures retain the previous release. Editable installs need no frontend. Formal wheels and source archives carry static assets, migrations, contracts, legal/configuration resources and candidate engine metadata.

Product/compiler/SDK0.1.0 and candidate engine1.0.0 are separate identities. Building does not approve an engine. Explicit operator promotion validates bytes and uses the existing issuer→inventory locks, preserving old versions and rejecting changed bytes under an existing version. Switch `validation_engine_version` only after promotion and Runtime installation. Frozen snapshots and signed packages retain their original identity.

Verify checksums, install into a new Python3.12 environment using the offline wheelhouse, initialize external configuration, run migration once, and then start the service behind HTTPS. Back up the database, artifacts and external keys before upgrades. Binary rollback requires a compatible database schema; otherwise restore the matching backup or repair forward. Debian candidate checks do not prove Ubuntu24.04 or the separately pinned container image. CI never receives production issuer keys or publishing credentials.


构建取消会等待阶段专用 Linux subreaper 回收全部后代，包括另起 session 的浏览器。监督者继承构建锁；十秒清理宽限后只杀未退出后代，不杀监督者来提前释放锁。若监督者异常退出且没有完整回收证明，`work/build-unsafe.json` 阻止后续构建。操作员应检查对应 run 的 `processes.json`、`child-*.json` 与残留进程，确认没有任何旧构建写入者后才手动移除隔离标记；构建器不自动清除它。

Cancellation waits for a stage-local Linux subreaper to reap all descendants, including detached browsers. The supervisor retains the build lock; escalation kills remaining descendants, never the supervisor as a substitute for cleanup. Missing completion proof creates `work/build-unsafe.json`, which blocks another build. Inspect the recorded run and confirm that all old writers have stopped before manually removing this marker.
