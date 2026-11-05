import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { digest, namespace } from "@perishcode/protocol";
import { channelDescriptor, formatReleaseVersion } from "@perishcode/release";
import { Client, readDirectory, serve } from "@perishcode/sidecar";
import { it } from "vitest";

it("uses the published factory as the shared truth for resources, generations and management", async () => {
  const root = await mkdtemp(join(tmpdir(), "slim-factory-"));
  const server = await serve(join(root, "manager.sock"));
  const product = { appid: "io.perish.opendesignslim", name: "Open Design Slim", scheme: "opendesignslim" };
  const stableIdentity = channelDescriptor("stable", product),
    betaIdentity = channelDescriptor("beta", product);
  const scope = { channel: stableIdentity.channel, namespace: namespace("release-shared") };
  const stable = server.factory(scope),
    beta = server.factory({ ...scope, channel: betaIdentity.channel });
  const identity = { service: "daemon", generation: digest(formatReleaseVersion(stableIdentity.channel, "1.2.3")) };
  const options = { identity, handlers: {}, lifecycle: { initialize: async () => {}, stop: async () => {} } };
  try {
    const first = await stable.expose(options),
      preview = await beta.expose(options);
    assert.notEqual(first.context.roots.data, preview.context.roots.data);
    const persistent = await stable.grant({ kind: "data", name: "same", scope: "factory" });
    const otherData = await beta.grant({ kind: "data", name: "same", scope: "factory" });
    assert.notEqual(persistent.value, otherData.value);
    await writeFile(join(persistent.value, "witness.json"), JSON.stringify({ version: "1.2.3", retained: true }));
    const port = await stable.grant({ kind: "port", name: "same", owner: "one", scope: "attempt" });
    const otherPort = await beta.grant({ kind: "port", name: "same", owner: "one", scope: "attempt" });
    const socket = await stable.grant({ kind: "socket", name: "same", owner: "one", scope: "attempt" });
    const otherSocket = await beta.grant({ kind: "socket", name: "same", owner: "one", scope: "attempt" });
    assert.notEqual(port.value, otherPort.value);
    assert.notEqual(socket.value, otherSocket.value);
    await assert.rejects(stable.revoke(otherPort.lease), /unknown/);
    await assert.rejects(stable.forward(port.lease, otherSocket.lease), /invalid forward/);
    await first.close();
    const second = await stable.expose({
      ...options,
      identity: { ...identity, generation: digest(formatReleaseVersion(stableIdentity.channel, "1.2.4")) },
    });
    assert.equal(first.context.roots.data, second.context.roots.data);
    const lease = await stable.start({
      generation: identity.generation,
      service: "probe",
      command: process.execPath,
      args: ["-e", "console.log('ready');setInterval(()=>{},1000)"],
      ready: "ready",
      grace: 100,
    });
    await assert.rejects(beta.release(lease), /factory identity mismatch/);
    await stable.release(lease);
    const remote = new Client(server.endpoint, server.authority).factory(scope);
    await remote.session(async (factory) => {
      assert.deepEqual(await factory.grant({ kind: "data", name: "same", scope: "factory" }), persistent);
      const journal = await factory.binding();
      assert.equal(journal.state.channel, scope.channel);
      assert.equal(journal.state.namespace, scope.namespace);
    });
    const ready = await remote.directory();
    assert.equal(ready.schema, 4);
    assert.equal(ready.factories.length, 1);
    assert.ok(ready.instances.every((entry) => entry.channel === "stable"));
    const registry = await remote.resources();
    assert.equal(registry.schema, 2);
    assert.equal(registry.channel, "stable");
    await server.close();
    const closed = await readDirectory(root);
    assert.equal(closed.factories.length, 2);
    const next = await serve(join(root, "next.sock"));
    try {
      assert.deepEqual(await next.factory(scope).grant({ kind: "data", name: "same", scope: "factory" }), persistent);
      assert.deepEqual(JSON.parse(await readFile(join(persistent.value, "witness.json"), "utf8")), {
        version: "1.2.3",
        retained: true,
      });
      const installed = createRequire(import.meta.url).resolve("@perishcode/sidecar");
      const version = JSON.parse(await readFile(join(dirname(dirname(installed)), "package.json"), "utf8")).version;
      assert.equal(version, "2.2.0");
      await mkdir("../../.artifacts/control", { recursive: true });
      await writeFile(
        "../../.artifacts/control/factory.json",
        JSON.stringify(
          {
            result: "passed",
            version,
            resolved: installed,
            ready,
            closed,
            registry,
            stableData: persistent.value,
            betaData: otherData.value,
            portIsolated: port.value !== otherPort.value,
            socketIsolated: socket.value !== otherSocket.value,
            generationDataRetained: true,
            normalReplacementDataRetained: true,
            foreignLeaseRejected: true,
            foreignForwardRejected: true,
            unqualified: [
              "recovery writes",
              "live-child adoption",
              "resource-use graph",
              "published four-unit factory migration",
            ],
          },
          null,
          2,
        ),
      );
    } finally {
      await next.close();
    }
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
it("rejects unsupported authority format without changing its bytes", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "slim-unsupported-")));
  try {
    const file = join(root, "manager.sqlite"),
      incarnation = randomUUID();
    const manager = { incarnation, pid: process.pid, phase: "closed" };
    const db = new DatabaseSync(file);
    db.exec(
      "CREATE TABLE authority(id INTEGER PRIMARY KEY,record TEXT); CREATE TABLE directory(id INTEGER PRIMARY KEY,record TEXT)",
    );
    db.prepare("INSERT INTO authority VALUES(1,?)").run(
      JSON.stringify({ schema: 1, directory: true, sessions: true, scope: file, ...manager }),
    );
    db.prepare("INSERT INTO directory VALUES(1,?)").run(
      JSON.stringify({ schema: 1, revision: 0, manager, namespaces: [], instances: [], sessions: [] }),
    );
    db.close();
    const hash = async () =>
      createHash("sha256")
        .update(await readFile(file))
        .digest("hex");
    const before = await hash();
    await assert.rejects(readDirectory(root), /recovery required/);
    await assert.rejects(serve(join(root, "blocked.sock")), /recovery required/);
    assert.equal(await hash(), before);
    await mkdir("../../.artifacts/control", { recursive: true });
    await writeFile(
      "../../.artifacts/control/unsupported.json",
      JSON.stringify({ result: "passed", before, after: await hash(), unsupportedFormatRejected: true }, null, 2),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
