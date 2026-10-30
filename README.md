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
会话不回滚外部动作、不超时抢占，不提供跨作用域事务。恢复写入、实例/资源使用关系和四单元控制面统一仍由 suite #10 推进；现有四单元运行时继续使用首版 SDK。
