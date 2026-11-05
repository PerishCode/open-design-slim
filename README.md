# open-design-slim

当前仅交付 electron/capsule/web/daemon 骨架与机制探针，不迁移 OpenDesign 功能。
长期方向见 [suite #1](https://github.com/PerishCode/electron-suite/issues/1)，消费者推进见 [#4](https://github.com/PerishCode/open-design-slim/issues/4)。

| 运行单元      | 职责                                 |
| ------------- | ------------------------------------ |
| apps/electron | 固定宿主，消费已发布的 Electron 适配 |
| apps/capsule  | 执行产品组合与注入资源探针           |
| apps/web      | 无样式的静态页面与窄 IPC 通信探针    |
| apps/daemon   | 消费发布包的最小健康/状态服务        |

## 开始迭代

使用 Node24/pnpm11.13.0，在用户 .npmrc 配置 GitHub Packages 凭证，然后显式执行：

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm lint
pnpm exec biome check .
pnpm exec pesuite guard
```

根 scripts 只有 lint/test/build，按模块递归分发；模块自己构建和检查 source/tests 类型。
内容准备与打包使用 pesuite release / pesuite pack；本地运行使用 Electron 正式入口。
控制面与安装产物验证位于模块 tests，实际 macOS 安装验收由 PESUITE_E2E=1 显式开启。
完整参数、环境约定、结果路径和分发流程统一维护在 [AGENTS.md](./AGENTS.md)。

所有通用机制来自固定版本 registry 包，无相邻源码依赖。Web 不取得服务 token 或 Node 控制面 API。
本阶段验收范围为本地内容与 unsigned macOS；签名、公网可信更新、多平台及完整中断恢复分别验收。

## 生命周期会话验证

独立消费 `@perishcode/sidecar` 0.5.0；daemon 的 sessions.test.ts 通过公开 Service.session / Client.session 验证批量编排、同作用域本地与 loopback 嵌套、并发排序、其他 channel 独立推进及过期上下文拒绝。
真实控制端 SIGKILL 后会话保持 interrupted 并阻塞同 lane，manager 关闭返回 recovery required；再次 SIGKILL manager 后通过 readDirectory 只读观察保留事实。证据位于 `.artifacts/control/sessions.json`。
会话不回滚外部动作、不超时抢占，不提供跨作用域事务。恢复写入、实例/资源使用关系和四单元控制面统一仍由 suite #10 推进；四单元 runtime/electron 0.2 的 factory SDK 交付见 suite #38。

## 渠道身份验证

通过 registry 固定消费 release 0.2.0，apps/capsule/tests/channel.test.ts 使用 slim 自己的产品身份验证 stable、beta 与自定义渠道的版本生成、安装身份、metadata 和 emit/read roundtrip。版本与 channel 不一致或发布 local 时拒绝；证据在 .artifacts/channel/receipt.json。
channel 与 namespace 共同确定资源 factory；sidecar 0.6 已提供 factory allocator，runtime/electron 0.2 接入该边界。渠道纠偏与后续验收见 suite #28；现有 probe 仅证明所执行的契约。

## Factory 资源边界验证

sidecar 0.6.0 / protocol 0.3.0 的独立 registry probe 使用 Service.factory/Client.factory，将 channel+namespace 绑定到资源、实例、会话与 binding。相同 namespace/service/resource 名的 stable/beta 隔离，generation 与正常 manager 更替保留持久数据，跨 factory 租约/forward 拒绝；资源 scope 使用 factory。证据在 .artifacts/control/factory.json。
旧 namespace-only schema-1 目录通过 unsupported-format refusal 显式只读检查，不猜测 stable，也不隐式迁移；哈希不变证据在 .artifacts/control/legacy.json。现有真实独立进程/SIGKILL probes 同时覆盖新 factory 记录，中断 lane 的资源写入也拒绝。
四单元已发布 runtime/electron 0.2 接入 sidecar 0.6/release 0.4.1，CLI 0.6 使用相同 SDK。root manager 故障域、恢复写入、存活子进程接管、资源使用关系与完整渠道发布编排继续见 suite #28/#30。

## 共享构建分发入口

产品只声明 pesuite.yaml/pipeline 的四单元模块路径和 blob 输入。固定版本 CLI 提供 version/build/check/pack/publish；--channel 只选择身份，质量关卡由 stable.release.yml 与 channel.release.yml 显式编排。每个 run 只有短 pesuite 调用，业务实现全部在 electron-suite。
本地示例：`pnpm exec pesuite build --channel preview --number 1`，随后 `pesuite pack --channel preview --platform mac`；policy/tests/artifacts/installed 是独立 check gate。实际命令与边界见 AGENTS.md。
两个 workflow 默认 publish=false；实验流程选择三个原生平台打包，正式流程在 macOS 额外选择 policy/tests/installed。当前产物 unsigned；打包通过不代表签名、公证、其他平台安装启动或远程更新验收完成。发布能力先上传 draft，再按显式模式提升，不覆盖已有 tag；没有为验证工具而公开发行产品版本。


runtime/electron 0.2 的运行收据包含 factory scope 和 sidecar directory 中的实际 daemon 进程身份。
apps/electron/tests/factory.test.ts 验证同管理根、同 namespace 的 stable/beta 隔离和跨版本数据连续。
PESUITE_E2E=1 的安装验收保留同一个宿主，验证四类内容更新、冷启动、失败激活和显式 binding 恢复。
真实 SIGKILL 后 daemon 随父管道关闭，manager 保留 interrupted 事实；再次启动拒绝，且 manager/factory 字节不变。
该拒绝是新 SDK 的约束，不提供 manager 恢复或旧 namespace 数据迁移；不得删除权威文件绕过。


自动化验证使用 electron SDK 0.2.1：PESUITE_PROBE=1 隐含后台模式并在 ready 后退出；
需要真实 SIGKILL 的长驻验证用 PESUITE_AUTOMATION=1、PESUITE_PROBE=0。
窗口隐藏且不可聚焦，macOS 在 ready 前使用 accessory activation policy。
HostReceipt.automation 记录 show/focus 及最终窗口事实；完整安装验收同时检查故障注入窗口保持后台。
正常交互启动仍使用默认显示/聚焦行为。Space 是否变化须单独观察，不能由隐藏窗口直接推断。


原生全屏验收由 `@perishcode/automation` 统一提供；产品只调用共享启动器和 Observer，不复制原生查询。
在已经处于原生全屏 Space 时运行 `PESUITE_E2E=1 PESUITE_DESKTOP=1 pnpm --filter @perishcode/slim-electron test`，覆盖安装流程中正常退出、失败启动和 SIGKILL。
每次启动前确认原生全屏，退出后继续观察 1500ms；环境不满足或用户主动切换 Space 时本轮不会通过。
也可先通过正式 build/pack，再显式执行 `pnpm exec pesuite check --channel preview --gate desktop` 的三场景独立关卡。
普通 installed / CI 的窗口检查不声称完成原生全屏验收。原生观察依赖 macOS Swift 工具链与只读诊断查询，正常产品启动不依赖它。

## 统一本地 inspect / serve

构建与准备 seed 后，`pnpm exec pesuite serve --channel stable --namespace slim` 按 pesuite.yaml 声明提供 web/seed 静态源。服务在前台运行，端口、socket、基础路径与退出由 sidecar 管理，SIGINT/SIGTERM 正常收敛。更新决策仍属于运行时消费者。

宿主显式启用 PESUITE_INSPECT=1 后注册产品自己的 status/echo 方法；配合 PESUITE_AUTOMATION=1 可保持后台调试。`pesuite inspect list --data <manager-root> --channel stable --namespace slim` 查询目标，再以 service/generation/incarnation 调用或停止。开发态与安装态使用同一公共入口，重启后的旧句柄不能操作新实例。

真实验证：`PESUITE_E2E=1 PESUITE_INSPECT_E2E=1 pnpm --filter @perishcode/slim-electron test`，证据 .artifacts/skeleton/inspect.json。此验证不代表原生全屏长序列、远程更新发现或故障下载 fixture 已通过。Refs electron-suite #44、#11、#12。

## 自动发现与候选准备

宿主可通过 PESUITE_FEED 与 PESUITE_FEED_KEY（固定公钥）启用 sidecar 托管的自动轮询。共享 update 包下载并校验静态 feed 的 Web/Daemon 候选，inspect 的 updates/status 区分 current 与 prepared、错误和 revision。停止服务会取消在途请求。

真实安装验证：`PESUITE_DISCOVERY_E2E=1 pnpm --filter @perishcode/slim-electron test`。本轮只准备候选，运行 binding、宿主、Capsule 和旧 Daemon 不变；不表示最小影响激活、接口兼容或新版本代码执行已通过。验收记录在 .artifacts/discovery/<run>/receipt.json，主线仍由 electron-suite #13 推进。

## 最小影响激活

PESUITE_LEAF_ACTIVATE=1 将已配置 feed 的准备流程接到 suite 的唯一激活控制者。Web-only 只换文档，Daemon-only 只换 daemon；unit.json 的独立版本与接口声明先通过校验。Web 资源 URL 带 artifact digest，验收同时核对实际执行见证，避免缓存旧 JS 被当作升级成功。

`PESUITE_LEAF_E2E=1 pnpm --filter @perishcode/slim-electron test` 验证同一安装宿主/Capsule、最小重启范围、数据保留、兼容拒绝、就绪失败及正常退出后的显式恢复。收据在 .artifacts/leaf/<run>/receipt.json；显式中断恢复见下文；live-process adoption、断电持久性与完整原生全屏仍由各自主线跟进。

Activation interruption probes: `PESUITE_INTERRUPTION_E2E=1 pnpm --filter @perishcode/slim-electron test` exercises four real installed SIGKILL boundaries via suite diagnostics and preserves .artifacts/interruption receipts/roots. Offline inspection uses sidecar readBinding; both ordinary and recover startup reject interrupted ownership without changing authority. The first phase proves safe refusal and retained data; the explicit recovery phase below verifies cold reopening. No power-loss durability or native fullscreen claim follows. See suite #50 under #13 and AGENTS.md for the opt-in pause inputs.

Sidecar2.0 consumes one stamped-supervisor model and current data format. Product code declares service identities and uses factory lifecycle APIs; stamp encoding, supervisor startup, OS census and signal escalation stay in suite. No legacy readers or old launch adapters are retained. Directory schema4 includes root/target and session controller birth witnesses and observeProcesses reports independent OS facts. Native interruption receipts include before/after process observations; the explicit recovery phase is required in addition to safe refusal.

Explicit recovery (#56) consumes sidecar2.0 through `pesuite recover inspect|apply --data <root> --expected <fingerprint>`. Root-wide inspection/refusal and retryable recovery stay in suite. Recovery preserves data/CAS/current, retires temporary resources and retains failed attempts for explicit product binding recovery. The installed interruption test now proves cold selection and retained data after four recoveries, including recovery itself being SIGKILLed and resumed. Current owner3/directory4 only; no old-format adapter or live adoption.


Capsule adapts Electron to Web/Daemon: loading, caller-owned IPC, od:// local routing, od-<channel>:// external actions and leaf-update lifecycle. It has no sidecar identity; Electron owns resources. #60 corrects the previous hosted model. Run skeleton+inspect, then PESUITE_PROTOCOL_E2E=1 for actual macOS background cold/warm URL dispatch to the retained installed app. Automatic Capsule replacement, Electron installation updates and full blob occupancy/GC remain tracked separately in suite #14/#15/#16.


Capsule handoff uses PESUITE_CAPSULE_ACTIVATE=1 alongside feed configuration. Stable bootstrap owns the Capsule observer, while loaded product code owns its leaf-update tasks. PESUITE_CAPSULE_E2E=1 verifies real installed Capsule-only/coordinated code replacement and failure recovery; PESUITE_CAPSULE_INTERRUPTION_E2E=1 verifies five handoff interruption/recovery points. Keep these probes separate and restore the normal build afterward. Capsule has artifact/version metadata and no sidecar identity.


Local object-store acceptance uses the pinned docker-compose.yml Silo. The distribution probe verifies signed metadata, a real S3-delivered content update, native minimum-shell blocking and compatible-shell admission; see AGENTS.md for the explicit commands. The separate installation probe below qualifies physical replacement.

Physical shell replacement is tracked by suite #66 / #15. The opt-in installation probe uses the published coordinator against actual Silo: old namespaces exit, the coordinator survives independently, the new app replaces the original path, and completion requires new-host readiness with retained data. See AGENTS.md for the local macOS matrix and explicit interruption/recovery commands.

The typed blob probe consumes the shared Library (#68 / #16): real Electron file/directory reads, explicit reference/occupancy protection, retention, GC and three interruption/recovery points. Run PESUITE_BLOB_E2E=1 as described in AGENTS.md. This covers Library-owned resources; whole-product generation-store GC remains separate.

Finite local closeout follows suite [#75](https://github.com/PerishCode/electron-suite/issues/75): real partial-directory GC interruption, vacated/confirming installation interruption, explicit recovery and retained audit materials. The installed probes use the published suite mechanisms. Envelope history and installation backups/downloads/executors remain long-term retained in this phase; GC of runtime CAS/views does not purge them. The next acceptance stage measures a continuous product journey, including disk cost.
