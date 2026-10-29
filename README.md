# open-design-slim

当前仅交付 `electron + capsule + web + daemon` 骨架，不迁移任何具体 OpenDesign 功能。
长期方向见 [electron-suite #1](https://github.com/PerishCode/electron-suite/issues/1)，本阶段见 [#2](https://github.com/PerishCode/open-design-slim/issues/2)。

## 运行单元

| 目录          | 职责                                                            |
| ------------- | --------------------------------------------------------------- |
| apps/electron | 固定安装宿主，消费 @perishcode/electron 的启动、安全及 IPC 适配 |
| apps/capsule  | 实际可执行的产品组合入口，读取注入的 probe 资源                 |
| apps/web      | 静态占位页面，验证浏览器到 Daemon 的健康检查、状态读写          |
| apps/daemon   | 消费 @perishcode/runtime 的最小本地服务与生命周期               |

通用工程能力从 GitHub Packages 安装固定版本；不引用 suite checkout，不复制其运行算法。
Web 使用窄 IPC 接口，不取得服务 token 或管理器权限。页面无样式定义。
`runtime:` 与 `guard:` 共用根目录 pesuite.yaml；公开工具入口保持 pesuite。

## 开发与验证

需要 Node24、pnpm11，以及配置了 @perishcode registry 读取权限的用户级 .npmrc。
仓库 .npmrc 只有路由，不包含 token。安装时允许 Electron/esbuild 的构建脚本。

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm start
pnpm test
pnpm typecheck
pnpm lint
pnpm guard
```

启动后页面展示 ready。状态仅为通信与数据保留探针，不包含业务模型。
原始 Electron 安装身份与内容 generation 分别管理；启动失败保留阻塞状态，显式恢复最近成功代际。

## macOS 实际产物验收

```sh
pnpm package
pnpm verify:skeleton
```

验收在 .artifacts/skeleton 下保留安装副本、数据和收据；只打包一次宿主，之后生成四类内容均变化的候选，
验证首次启动、冷启动、内容激活、再次冷启动、不兼容候选拒绝、失败阻塞、显式恢复及主进程 SIGKILL 后 Daemon 退出。
完整 .app 在内容更新前后的文件树摘要必须一致。可从脚本最终输出路径手工打开安装副本。

内部验收参数 PESUITE_DATA、PESUITE_CANDIDATE、PESUITE_PROBE、PESUITE_RECEIPT 与 PESUITE_RECOVER
仅用于选择隔离数据、本地候选、验收模式及显式恢复；PESUITE_BUILD 生成不同探针内容。
正常开发不需要这些参数。

本阶段是 unsigned macOS 骨架和本地内容激活验证。公网可信分发、签名／公证／安装器、其他平台进程树、
系统级助手进程枚举与提交中的崩溃恢复仍未验收。
