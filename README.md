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
旧 namespace-only schema-1 目录通过 readLegacyDirectory 显式只读检查，不猜测 stable，也不隐式迁移；哈希不变证据在 .artifacts/control/legacy.json。现有真实独立进程/SIGKILL probes 同时覆盖新 factory 记录，中断 lane 的资源写入也拒绝。
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
