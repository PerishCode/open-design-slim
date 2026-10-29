# open-design-slim

OpenDesign 的工程优化版本，以发布的 electron-suite npm packages 承接通用工程能力。

## 开发

使用 Node.js 24 和 pnpm 11.13.0。包从 GitHub Packages 获取；仓库 `.npmrc` 仅声明 `@perishcode` registry，凭证保留在用户级 `~/.npmrc`。

```sh
pnpm install --frozen-lockfile
pnpm guard
pnpm lint
```

唯一检查入口是 `pesuite guard`，配置为根 `pesuite.yaml`。`@perishcode/cli` 使用精确发布版本，不引用 electron-suite checkout。

`apps/` 与 `packages/` 暂为空骨架，后续按需求逐步引入产品代码。工程规范与能力交付目标见 [electron-suite #1](https://github.com/PerishCode/electron-suite/issues/1)。
