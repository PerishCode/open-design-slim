# open-design-slim

Read [electron-suite #1](https://github.com/PerishCode/electron-suite/issues/1) for the shared engineering direction and [#3](https://github.com/PerishCode/electron-suite/issues/3) for guard delivery.

Consume published `@perishcode` packages from GitHub Packages; do not copy suite rules, wrappers, or source, and do not rely on adjacent checkouts. The CLI entry is `pesuite guard`; repository configuration is `pesuite.yaml` under the `guard` namespace.

Keep GitHub Packages tokens only in user-level npm configuration. Repository `.npmrc` contains registry routing only.

- `apps/`: product applications; `packages/`: product-owned shared capabilities.
- Each workspace package is a module. Its root is depth 0; src/tests start at 1.
- Directory depth <=5, direct children <=8. Tests obey the same rules.
- Source/test files <=500 physical lines. Tests live at `tests/**/*.test.ts`.
- Only exact configured components paths are exempt from width; only `packages/components/**/*.less` may define stylesheets.
- Modules own independent source/test tsconfigs; test aliases point @ to src.
- Use TypeScript 7, Vitest and Biome. Pin external dependencies to x.y.z and local ones to workspace:*.
- Run `pnpm guard` and `pnpm lint` after changes; add module build/test/typecheck validation when product modules exist.

Do not close electron-suite #1 for a partial delivery.
