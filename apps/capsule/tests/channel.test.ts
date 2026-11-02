import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  channelDescriptor,
  decode,
  distinct,
  emit,
  formatReleaseVersion,
  parse,
  parseReleaseVersion,
  releaseChannel,
  releaseMetadataVersionFields,
  resolve,
} from "@perishcode/release";
import { it } from "vitest";

it("consumes product channel identity and canonical versions from the published release contract", async () => {
  const root = await mkdtemp(join(tmpdir(), "slim-channel-"));
  const product = { appid: "io.perish.opendesignslim", name: "Open Design Slim", scheme: "opendesignslim" };
  try {
    const manifests = [];
    for (const lane of ["stable", "beta", "qa2", "123"]) {
      const descriptor = channelDescriptor(lane, product);
      const version = formatReleaseVersion(lane, "1.2.3", lane === "stable" ? undefined : 4);
      const manifest = resolve({}, { channel: descriptor.channel, version }, product);
      assert.equal(manifest.identity.version, version);
      assert.equal(manifest.identity.appid, lane === "stable" ? product.appid : `${product.appid}.${lane}`);
      assert.equal(descriptor.storagePrefix, lane);
      assert.equal(parseReleaseVersion(version).channel, lane);
      const path = await emit(join(root, lane), manifest);
      assert.deepEqual(decode(await readFile(path, "utf8")), manifest);
      assert.equal(releaseMetadataVersionFields(lane, version).releaseVersion, version);
      manifests.push(manifest);
    }
    distinct(manifests);
    const beta = manifests[1];
    assert.ok(beta);
    assert.throws(() => parse({ ...beta, channel: "stable" }), /mismatch/);
    assert.throws(
      () => resolve({ version: () => "1.2.3" }, { channel: beta.channel, version: beta.identity.version }, product),
      /mismatch/,
    );
    assert.throws(() => releaseChannel("local"), /reserved/);
    assert.throws(() => parseReleaseVersion("1.2.3-beta-internal.4"));
    const installed = createRequire(import.meta.url).resolve("@perishcode/release");
    const version = JSON.parse(await readFile(join(dirname(dirname(installed)), "package.json"), "utf8")).version;
    assert.equal(version, "0.3.0");
    await mkdir("../../.artifacts/channel", { recursive: true });
    await writeFile(
      "../../.artifacts/channel/receipt.json",
      JSON.stringify(
        {
          result: "passed",
          version,
          resolved: installed,
          manifests,
          localPublishRejected: true,
          channelMismatchRejected: true,
          unqualified: [
            "factory resource isolation",
            "four-unit runtime channel migration",
            "remote release publication",
          ],
        },
        null,
        2,
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
