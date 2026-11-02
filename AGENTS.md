# open-design-slim

## Meta rules

- [suite #1](https://github.com/PerishCode/electron-suite/issues/1) owns the shared direction and stays Open. [slim #4](https://github.com/PerishCode/open-design-slim/issues/4) owns current consumer acceptance; suite #10–#16 own the mechanisms.
- Scope is electron/capsule/web/daemon skeletons and probes only. Do not migrate OpenDesign features, business APIs or data models.
- Consume fixed @perishcode versions from GitHub Packages; do not copy suite mechanisms or use adjacent checkouts, workspace links or tarball overrides for delivery. Tokens belong in user .npmrc.
- [suite #28](https://github.com/PerishCode/electron-suite/issues/28) owns channel correction: channel is product distribution identity and channel + namespace identifies a resource factory. Sidecar 0.6 probes qualify channel+namespace factory resource isolation; the published four-unit SDK still needs factory migration.
- Public lifecycle capabilities use pesuite or the owning package APIs/tests. package.json scripts only contain lint/test/build; the root dispatches `pnpm -r --if-present run <same-name>`. Modules own their tools; no root callbacks, lifecycle hooks, shortcuts or scripts directories.
- Use bound Service.factory/Client.factory and hosted Context (or published runtime adapters) for downstream lifecycle/resources. Do not assemble product management from raw launch/process scans/private ports or paths; persistent directory guarantees apply to Service-owned instances.
- guard owns engineering compliance. Validate changed modules, direct root formatting/config checks and guard; retain actual acceptance evidence. Sidecar 0.6 adds factory resource management on persistent instance/session inventory; recovery writes and live-process adoption remain unqualified.

## Directory conventions

- Every directory node must match guard's repository-relative or module-relative allowlist. Parent approval does not approve descendants; this includes hidden, empty and tests directories.
- Authorized patterns permit routine expansion within their declared scope. For a new responsibility or pattern, obtain scope authorization, declare bounded patterns in pesuite.yaml, and update regression coverage and the relevant index. Do not widen patterns, excludes or exceptions just to silence findings. The structure may evolve through this process.
- Generated/dependency/runtime directories have fixed owned boundaries; exclusions do not authorize source or resource trees. Source resources must follow the declared resource lifecycle.

- apps/electron is the stable host, apps/capsule the composition entry, apps/web a static browser probe, apps/daemon a local service probe. packages is reserved for product-owned shared modules.
- Modules use src and sibling tests/**/*.test.ts, independent tsconfigs, and module-owned tool configs.
- Brief scale: source <=500 lines; module depth <=5 and width <=8; components width exemption only; styles confined to packages/components/**/*.less. TS7/Vitest/Biome and exact external versions remain required.
- These summaries aid navigation; guard configuration and findings determine compliance.

## Core file index

| File or location                                    | Responsibility                                                       |
| --------------------------------------------------- | -------------------------------------------------------------------- |
| package.json / pnpm-workspace.yaml / pnpm-lock.yaml | three standard dispatchers, module membership and registry closure   |
| pesuite.yaml / biome.json / .npmrc                  | guard/runtime identity, formatter/linter policy, registry routing    |
| apps/*/esbuild.config.mjs                           | each module's own build, with no call back to the root               |
| apps/electron/src/main.ts                           | published host adapter bootstrap                                     |
| apps/capsule/src/index.ts                           | executed composition entry and injected resource probe               |
| apps/web/src/index.ts / index.html                  | browser bridge and placeholder page                                  |
| apps/daemon/src/main.ts                             | published minimal daemon service                                     |
| apps/capsule/tests/channel.test.ts                  | published release contract and explicit product channel identity     |
| apps/daemon/tests/factory.test.ts                   | cross-channel resource isolation and explicit legacy read-only facts |
| apps/daemon/tests/sessions.test.ts                  | lifecycle batches, private nesting and interrupted owner fencing     |
| apps/daemon/tests/directory.test.ts                 | factory continuity and interrupted read-only inventory               |
| apps/daemon/tests/ownership.test.ts                 | registry ownership, normal replacement and real SIGKILL acceptance   |
| apps/daemon/tests/control.test.ts                   | hosted control and resource lifecycle acceptance                     |
| apps/electron/tests/skeleton.test.ts                | opt-in real unsigned installed lifecycle acceptance                  |
| .artifacts                                          | generated seed, package, installed copies and execution receipts     |

## Iteration workflows

### Local environment

Local checkouts live under ~/Projects/perish.work/open-design-slim and ~/Projects/perish.work/electron-suite. Historical receipts retain their original paths.
Use Node24 and pnpm11.13.0. Configure package read credentials in user .npmrc. Run `pnpm install --frozen-lockfile`, then `pnpm build` explicitly.
Build includes both source and test type checking. Installation does not trigger project aggregation.

### Local debugging

Build modules, prepare the seed using the content command below, then run `pnpm exec electron apps/electron/dist/main.mjs`.
The page must reach ready through actual Capsule/Web/Daemon execution. PESUITE_DATA selects isolated data; PESUITE_PROBE=1 and PESUITE_RECEIPT select the existing host probe mode. Unified inspect/serve remain upstream #11/#12 work.

### Local build and standard checks

Use `pnpm --filter @perishcode/slim-<unit> build|test|lint` for module iteration.
At repository scope run `pnpm build`, `pnpm test`, `pnpm lint`, `pnpm exec biome check .`, and `pnpm exec pesuite guard`.
Format with `pnpm exec biome check --write .`; there are no typecheck/format/guard aliases.

### Content generation and packaging

After the modules have built:

```sh
pnpm exec pesuite release --capsule apps/capsule/dist --daemon apps/daemon/dist --web apps/web/dist --blob probe=apps/capsule/dist/probe.bin --output .artifacts/seed
pnpm exec pesuite pack --carrier apps/electron/dist --seed .artifacts/seed --output .artifacts/package --receipt .artifacts/package.json
```

release composes verified local content using pesuite.yaml/runtime. pack consumes those exact seed bytes and is currently unsigned macOS. Neither command implicitly builds the modules. PESUITE_BUILD creates changed probe content during module build.

### Local end-to-end verification

`pnpm --filter @perishcode/slim-daemon test` covers caller-defined hosted RPC, managed port/socket forwarding, failed drain/retry and incarnation fencing. It records .artifacts/control/receipt.json.
It also runs ownership.test.ts: real independent managers compete, normal drain permits replacement, SIGKILL blocks reopening and preserves interrupted truth. Evidence is .artifacts/control/ownership.json. Never delete authority/registry files to bypass recovery-required errors; explicit interrupted adoption is still upstream work.
It also runs directory.test.ts: Service/factory.directory inventory for hosted and independent processes, factory continuity across managers, and readDirectory after SIGKILL without authority/registry writes. Evidence is .artifacts/control/directory.json. FactoryEntry.phase describes resource authority; instance phases are last committed facts and do not prove current PID liveness.
Use Service.factory/Client.factory with the resolved distribution channel and explicit namespace. Use factory.session(scopedFactory => ...) to group lifecycle/resource operations. Scope is namespace/channel within the manager root. Same-scope callbacks may reenter; cross-scope nesting is rejected. Scoped Clients expire after callbacks. Business handlers require an existing controller session before lifecycle writes. Resource and binding entries also participate in factory sessions; business handler allocations need an existing controller session. Raw Resources/Bindings/Sidecar are not product orchestration entry points.
The sessions.test.ts registry probe records .artifacts/control/sessions.json: independent controllers, queue ordering, local/loopback nesting, callback failure, expired context and real SIGKILL. Unclean controller disconnect blocks its lane; it does not authorize timeout stealing. Shutdown reports recovery required and retains authority until future reconciliation.
The capsule channel.test.ts independently consumes release 0.3.0 to prove product-owned channel/version identity, emitted manifests and mismatched-channel rejection. It records .artifacts/channel/receipt.json. The four-unit runtime still consumes its original release/sidecar dependency closure; this contract probe does not claim runtime factory migration.
factory.test.ts independently verifies equal resource/service names across channels, same-factory generation/normal-manager continuity, foreign lease/forward rejection and explicit schema-1 inspection without writes. Evidence is .artifacts/control/factory.json and legacy.json. New Directory/Registry schema is 2, resource persistent scope is factory. Old namespace-only roots require explicit migration; no guessed stable or automatic cleanup.
On macOS with a desktop session, run `PESUITE_E2E=1 pnpm --filter @perishcode/slim-electron test` after installing and building.
That opt-in test builds probe versions, invokes the formal release/pack capabilities, retains one installed host, verifies four changed contents, cold starts, ABI rejection, failed activation, explicit recovery and post-ready SIGKILL. Evidence and installed copies remain under .artifacts/skeleton.
Ordinary pnpm test skips that installed test; it never implies that real installation acceptance ran.

### Distribution and handoff

Upgrade fixed registry versions only after suite publishes them. Verify archive integrity and resolved paths, frozen install, module checks, guard and the relevant actual lifecycle tests.
Record source/consumer commits, package versions, commands, results and unqualified boundaries in slim #4 and the owning suite issue.
The four-unit runtime still uses the first SDK; directory/ownership/sessions/factory 0.6 is a separate probe. Signing, authenticated remote feeds, other platforms, complete process census and crash-during-commit require their own evidence.
