/**
 * Real stdio handshake against the built server.
 *
 * This is the test that matters. The server this replaces was never successfully
 * connected by anyone: it required cloning a private repository, so the first external
 * tester's client just said "failed". Asserting that the process starts, completes an
 * MCP initialize, and lists its tools is the difference between shipping a server and
 * shipping a README.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

const ENTRY = fileURLToPath(new URL("../dist/index.js", import.meta.url));
let protocolApi;
let protocolApiUrl;

before(async () => {
  protocolApi = createServer((request, response) => {
    assert.equal(request.url, "/v1/capabilities");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        api_version: "1",
        operations: ["text_to_image", "image_to_image", "background_remove", "upscale"],
      }),
    );
  });
  await new Promise((resolve) => protocolApi.listen(0, "127.0.0.1", resolve));
  protocolApiUrl = `http://127.0.0.1:${protocolApi.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) =>
    protocolApi.close((error) => (error ? reject(error) : resolve())),
  );
});

/**
 * Speak newline-delimited JSON-RPC to a spawned server and collect the replies.
 *
 * `expectExit` matters. A server that refuses to start exits on its own, and killing it
 * on a timer races that: on a loaded machine the kill can land before the child reaches
 * its exit path, and the observed code becomes null instead of 1. Those cases wait for
 * the real exit and never kill.
 */
function withServer(env, exchange, { expectExit = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ENTRY], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`timed out. stderr: ${stderr}`));
    }, 10_000);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });

    exchange(child).then(
      () => {
        if (!expectExit) setTimeout(() => child.kill(), 400);
      },
      (error) => {
        clearTimeout(timer);
        child.kill();
        reject(error);
      },
    );
  });
}

const send = (child, message) => {
  child.stdin.write(`${JSON.stringify(message)}\n`);
};

/** Wait for one JSON-RPC response instead of guessing how long a loaded runner needs. */
function waitForReply(child, id) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for JSON-RPC id ${id}`));
    }, 8_000);
    const onExit = (code) => {
      cleanup();
      reject(new Error(`server exited with ${code} before JSON-RPC id ${id}`));
    };
    const onData = (chunk) => {
      buffer += chunk.toString();
      let boundary = buffer.indexOf("\n");
      while (boundary >= 0) {
        const line = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 1);
        if (line) {
          const message = JSON.parse(line);
          if (message.id === id) {
            cleanup();
            resolve(message);
            return;
          }
        }
        boundary = buffer.indexOf("\n");
      }
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.off("exit", onExit);
    };
    child.stdout.on("data", onData);
    child.on("exit", onExit);
  });
}

test("refuses to start without a key, and says how to fix it", async () => {
  const { code, stdout, stderr } = await withServer(
    { DREAMLAYER_API_KEY: "" },
    async () => {},
    { expectExit: true },
  );

  assert.equal(code, 1, "a server with no key must exit rather than advertise dead tools");
  assert.match(stderr, /DREAMLAYER_API_KEY is not set/);
  // The failure a client actually hits: the key is in the user's shell, not the
  // subprocess. Saying so is the difference between a fix and a support ticket.
  assert.match(stderr, /does not reach it/);
  assert.match(stderr, /platform\.dreamlayer\.io/);
  assert.equal(stdout, "", "nothing but JSON-RPC may ever touch stdout");
});

test("completes an MCP initialize and lists its tools over stdio", async () => {
  const { stdout, stderr } = await withServer(
    {
      DREAMLAYER_API_KEY: "dlr_live_not_a_real_key_for_protocol_only",
      DREAMLAYER_API_URL: protocolApiUrl,
    },
    async (child) => {
      const initializeReply = waitForReply(child, 1);
      send(child, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test", version: "0" },
        },
      });
      await initializeReply;
      send(child, { jsonrpc: "2.0", method: "notifications/initialized" });
      const listReply = waitForReply(child, 2);
      send(child, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
      await listReply;
    },
  );

  const messages = stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  const initialize = messages.find((m) => m.id === 1);
  assert.ok(initialize, `no initialize reply. stderr: ${stderr}`);
  assert.equal(initialize.result.serverInfo.name, "dreamlayer");
  assert.ok(initialize.result.capabilities.tools, "the server must advertise tool support");

  const list = messages.find((m) => m.id === 2);
  assert.ok(list, "no tools/list reply");
  const names = list.result.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    "dreamlayer_balance",
    "dreamlayer_capabilities",
    "dreamlayer_download",
      "dreamlayer_events",
    "dreamlayer_execution",
    "dreamlayer_generate",
    "dreamlayer_upload_image",
  ]);

  // No local-runtime tool may survive: those died with the runtime, and advertising
  // one would send a model down a path that no longer exists.
  assert.ok(
    !names.some((name) => /policy|connector|workflow|runtime/i.test(name)),
    "a retired local-runtime tool is being advertised",
  );
});

test("every tool declares a closed input schema", async () => {
  const { stdout } = await withServer(
    {
      DREAMLAYER_API_KEY: "dlr_live_not_a_real_key_for_protocol_only",
      DREAMLAYER_API_URL: protocolApiUrl,
    },
    async (child) => {
      const initializeReply = waitForReply(child, 1);
      send(child, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
      });
      await initializeReply;
      send(child, { jsonrpc: "2.0", method: "notifications/initialized" });
      const listReply = waitForReply(child, 2);
      send(child, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
      await listReply;
    },
  );

  const list = stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .find((m) => m.id === 2);

  for (const tool of list.result.tools) {
    assert.equal(
      tool.inputSchema.additionalProperties,
      false,
      `${tool.name} accepts undeclared fields`,
    );
    assert.ok(tool.description.length > 20, `${tool.name} has no usable description`);
  }
});

test("refuses to start when pointed at a host that is not DreamLayer", async () => {
  // Same guard as the CLI, and the same reason: a build once pointed the endpoint at the
  // marketing apex and sent bearer keys there for two days. Failing at startup means a
  // misconfigured client never gets as far as making that request.
  const { code, stderr, stdout } = await withServer(
    { DREAMLAYER_API_KEY: "dlr_live_test", DREAMLAYER_API_URL: "https://dreamlayer.io" },
    async () => {},
    { expectExit: true },
  );

  assert.equal(code, 1);
  assert.match(stderr, /Refusing to send an API key to dreamlayer\.io/);
  assert.equal(stdout, "", "nothing but JSON-RPC may ever touch stdout");
});

test("the generate tool still offers every operation the API supports", async () => {
  // The operations are the reason a model can ask for a cutout deterministically rather
  // than describing one and hoping. Losing them silently would be a real regression.
  const { stdout } = await withServer(
    { DREAMLAYER_API_KEY: "dlr_live_test", DREAMLAYER_API_URL: protocolApiUrl },
    async (child) => {
      const initializeReply = waitForReply(child, 1);
      send(child, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
      });
      await initializeReply;
      send(child, { jsonrpc: "2.0", method: "notifications/initialized" });
      const listReply = waitForReply(child, 2);
      send(child, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
      await listReply;
    },
  );

  const list = stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .find((m) => m.id === 2);
  const generate = list.result.tools.find((tool) => tool.name === "dreamlayer_generate");

  assert.deepEqual(generate.inputSchema.properties.operation.enum, [
    "text_to_image",
    "image_to_image",
    "background_remove",
    "upscale",
  ]);
});
