import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { configuration, selectedVersion, validateWorkflows } from "@perishcode/pipeline";
import { it } from "vitest";

it("consumes the shared pipeline contract and leaves the release quality gap in thin workflows", async () => {
  const root = resolve("../.."),
    config = await configuration(root, "preview");
  const selected = await selectedVersion({ root, channel: "preview", number: 7 });
  assert.equal(selected.version, `${config.baseVersion}-preview.7`);
  assert.equal(config.product.appid, "io.perish.opendesignslim");
  assert.equal(config.units.carrier, join(root, "apps/electron"));
  const workflows = await validateWorkflows(root);
  const stable = workflows["stable.release.yml"],
    experimental = workflows["channel.release.yml"];
  assert.ok(stable && experimental);
  for (const gate of ["policy", "tests", "artifacts", "installed"])
    assert.ok(stable.some((entry) => entry.includes(`--gate ${gate}`)));
  assert.ok(experimental.some((entry) => entry.includes("--gate artifacts")));
  assert.ok(!experimental.some((entry) => /--gate (policy|tests|installed)/.test(entry)));
  assert.ok([...stable, ...experimental].every((entry) => !entry.includes("\n")));
  const file = createRequire(import.meta.url).resolve("@perishcode/pipeline");
  const version = JSON.parse(await readFile(join(dirname(dirname(file)), "package.json"), "utf8")).version;
  assert.equal(version, "0.2.0");
  await mkdir("../../.artifacts/pipeline", { recursive: true });
  await writeFile(
    "../../.artifacts/pipeline/contract.json",
    JSON.stringify(
      {
        result: "passed",
        version,
        resolved: file,
        selected,
        workflows,
        unqualified: ["signing and notarization", "authenticated remote updates", "new four-unit SDK migration"],
      },
      null,
      2,
    ),
  );
});
