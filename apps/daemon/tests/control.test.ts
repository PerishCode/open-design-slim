import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { channel, digest, namespace } from "@perishcode/protocol";
import { type Attachment, Client, type Context, Resources, serve } from "@perishcode/sidecar";

import { it } from "vitest";

type Methods = {
  describe: { input: null; output: { identity: Context["identity"]; incarnation: string; address: string } };
  echo: { input: { probe: string }; output: { received: { probe: string } } };
};
it("validates hosted control and managed resource teardown", async () => {
  // Caller-owned probe protocol, using only the published sidecar contract.
  const root = await mkdtemp(join(tmpdir(), "slim-control-"));
  const server = await serve(join(root, "manager.sock"));
  const client = new Client(server.endpoint, server.authority);
  const identity = {
    channel: channel("stable"),
    namespace: namespace("slim"),
    service: "probe",
    generation: digest("hosted skeleton probe"),
  };
  const nextIdentity = { ...identity, generation: digest("next hosted skeleton probe") };
  const http = createServer((_request, response) => response.end("slim static probe"));
  let address = "";
  let socketPath = "";
  let failure = true;
  let attachment: Attachment | undefined;
  const cases: string[] = [];
  try {
    attachment = await server.expose<Methods>({
      identity,
      handlers: {
        describe: (_input, context) => ({ identity: context.identity, incarnation: context.incarnation, address }),
        echo: (input) => ({ received: input }),
      },
      lifecycle: {
        initialize: async (context) => {
          const socket = await context.allocate({ kind: "socket", name: "static" });
          const port = await context.allocate({ kind: "port", name: "static", scheme: "http" });
          socketPath = socket.value;
          address = port.value;
          await new Promise<void>((done, reject) => {
            http.once("error", reject);
            http.listen(socketPath, done);
          });
          await context.forward(port.value, socketPath);
          await writeFile(join(context.roots.data, "probe.json"), JSON.stringify({ retained: true }));
        },
        stop: async () => {
          if (failure) throw new Error("injected drain failure");
          await new Promise<void>((done, reject) => http.close((error) => (error ? reject(error) : done())));
        },
      },
    });
    await assert.rejects(serve(join(root, "contender.sock"), undefined, undefined, root), /held/);
    await assert.rejects(Resources.open({ root, namespace: identity.namespace }), /held/);
    cases.push("manager and namespace ownership are exclusive before touching existing resources");
    const peer = await client.connect<Methods>(identity);
    const description = await peer.call("describe", null);
    assert.deepEqual(description.identity, identity);
    assert.deepEqual(await peer.call("echo", { probe: "caller owns this message" }), {
      received: { probe: "caller owns this message" },
    });
    assert.equal(await (await fetch(address, { headers: { connection: "close" } })).text(), "slim static probe");
    cases.push("caller-defined RPC and managed port/socket forwarding");
    await assert.rejects(peer.stop(), /injected drain failure/);
    assert.equal((await peer.probe()).phase, "failed");
    assert.equal((await stat(socketPath)).isSocket(), true);
    assert.equal((await stat(attachment.context.roots.runtime)).isDirectory(), true);
    await assert.rejects(
      server.expose({
        identity: nextIdentity,
        handlers: {},
        lifecycle: {
          initialize: async () => {},
          stop: async () => {},
        },
      }),
      /already owned/,
    );
    cases.push("failed drain retains authority and resources across generation replacement");
    failure = false;
    await peer.stop();
    await attachment.closed;
    await assert.rejects(peer.call("describe", null), /fenced/);
    await assert.rejects(fetch(address, { signal: AbortSignal.timeout(1000) }));
    await assert.rejects(stat(socketPath), { code: "ENOENT" });
    await assert.rejects(stat(attachment.context.roots.runtime), { code: "ENOENT" });
    assert.deepEqual(JSON.parse(await readFile(join(attachment.context.roots.data, "probe.json"), "utf8")), {
      retained: true,
    });
    cases.push("explicit retry drains and retires temporary resources; persistent data retained");
    const replacement = await server.expose<{ echo: { input: string; output: string } }>({
      identity: nextIdentity,
      handlers: { echo: (input) => input },
      lifecycle: { initialize: async () => {}, stop: async () => {} },
    });
    await attachment.close();
    await assert.rejects(client.connect(identity), /not ready/);
    await assert.rejects(peer.stop(), /fenced/);
    assert.equal(
      await (await client.connect<{ echo: { input: string; output: string } }>(nextIdentity)).call(
        "echo",
        "replacement",
      ),
      "replacement",
    );
    await replacement.close();
    const grants = (await client.resources(identity.namespace)).grants;
    assert.ok(grants.every((grant) => grant.scope === "namespace"));
    cases.push("old generation/incarnation cannot stop successor; no temporary resource grants remain");
    await mkdir("../../.artifacts/control", { recursive: true });
    await writeFile(
      "../../.artifacts/control/receipt.json",
      JSON.stringify(
        {
          schema: 1,
          result: "passed",
          identity,
          nextIdentity,
          replacementIncarnation: replacement.context.incarnation,
          incarnation: description.incarnation,
          pid: process.pid,
          cases,
          grants: grants.map(({ kind, scope }) => ({ kind, scope })),
          scope:
            "registry consumer of exclusive ownership and hosted generation fencing; interrupted adoption remains unqualified",
        },
        null,
        2,
      ),
    );
    console.log(JSON.stringify({ result: "passed", receipt: "../../.artifacts/control/receipt.json", cases }));
  } finally {
    failure = false;
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
