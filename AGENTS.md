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

## Current scope: four-unit skeleton only

Read [slim #2](https://github.com/PerishCode/open-design-slim/issues/2),
[suite #7](https://github.com/PerishCode/electron-suite/issues/7) and
[suite #8](https://github.com/PerishCode/electron-suite/issues/8).
Do not migrate any concrete OpenDesign feature, business API or data model in this phase.

- `apps/electron`: stable installed host entry; delegates mechanisms to the published Electron adapter.
- `apps/capsule`: product composition entry; consumes injected resources and declares readiness.
- `apps/web`: static placeholder and browser/daemon communication probe. No separate SSR process.
- `apps/daemon`: minimal health/state probe; generic server and lifecycle come from published runtime.
- `scripts/`: thin build/package entries and product integration acceptance, no duplicated runtime algorithms.

Product declarations live under `runtime:` in pesuite.yaml.
Run build, test, typecheck, lint and guard before delivery.
On macOS with a desktop session, run `pnpm verify:skeleton` for real packaged acceptance.
Electron and Daemon have no redundant unit test fixtures; their actual startup/stop is covered by
the SDK tests and the product's packaged acceptance. Capsule and browser contract unit tests live in tests.
Local candidate directories are explicit trusted test inputs. Signing, remote feeds,
other platforms and crash-during-commit remain separate acceptance work.

## Active capability increment

The current roadmap is suite #10–#16 and slim #4. Start with sidecar resource authority.
`pnpm verify:control` consumes published sidecar 0.2.0 for caller-defined hosted methods,
managed port/socket forwarding and failed-stop ownership. The four-unit runtime remains on the first SDK.
This probe does not prove cross-process manager authority or restart adoption; keep those gates open.
