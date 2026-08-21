/**
 * Tool calls driven through the real JSON-RPC surface against a fake Agent API.
 *
 * The protocol tests prove the server starts and lists its tools. They never prove a
 * tool CALL produces a correct request, which is the gap that let a client ship a field
 * the API rejects and still pass a green suite. The fake here mirrors the real CLOSED
 * request model: an unknown key is a 422, not something quietly ignored.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ENTRY = fileURLToPath(new URL("../dist/index.js", import.meta.url));

/** Exactly the fields /v1/execute accepts. Kept in sync with the gateway's ExecuteRequest. */
const ALLOWED_EXECUTE_FIELDS = [
  "prompt",
  "respond",
  "conversation_id",
  "input_asset_id",
  "aspect_ratio",
  "operation",
  "max_credits",
];

function fakeApi(behaviour) {
  const calls = [];
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      calls.push({ url: request.url, headers: request.headers, body });

      if (request.url === "/v1/capabilities") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            api_version: "1",
            key_mode: "live",
            operations: ["text_to_image", "image_to_image", "background_remove", "upscale"],
          }),
        );
        return;
      }

      if (request.url === "/v1/execute") {
        if (behaviour.status && behaviour.status !== 200) {
          response.writeHead(behaviour.status, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              error: {
                code: "VALIDATION_FAILED",
                message: behaviour.message ?? "nope",
                request_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
              },
            }),
          );
          return;
        }
        // Closed model. A field the gateway does not declare is a hard 422.
        const extra = Object.keys(body).filter((key) => !ALLOWED_EXECUTE_FIELDS.includes(key));
        if (extra.length > 0) {
          response.writeHead(422, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              error: {
                code: "VALIDATION_FAILED",
                message: `Extra inputs are not permitted: ${extra.join(", ")}`,
                request_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
              },
            }),
          );
          return;
        }
        response.writeHead(200, { "content-type": "text/event-stream" });
        for (const [index, block] of (behaviour.events ?? []).entries()) {
          response.write(
            `id: ${index + 1}\nevent: ${block.event}\ndata: ${JSON.stringify(block.data)}\n\n`,
          );
        }
        response.end();
        return;
      }
      response.writeHead(404).end();
    });
  });
  return { server, calls };
}

async function listen(handler) {
  const { server, calls } = handler;
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    calls,
    close: () => server.close(),
  };
}

/** Spawn the server, initialize, call one tool, return its parsed result. */
function callTool(apiUrl, name, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ENTRY], {
      env: { ...process.env, DREAMLAYER_API_KEY: "dlr_live_test_key", DREAMLAYER_API_URL: apiUrl },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`timed out. stderr: ${stderr}`));
    }, 12_000);

    child.stdout.on("data", (c) => (stdout += c.toString()));
    child.stderr.on("data", (c) => (stderr += c.toString()));

    const send = (m) => child.stdin.write(`${JSON.stringify(m)}\n`);
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "t", version: "0" },
      },
    });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });

    setTimeout(() => {
      send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });
    }, 300);

    setTimeout(() => {
      clearTimeout(timer);
      child.kill();
      const reply = stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .find((m) => m.id === 2);
      if (!reply) {
        reject(new Error(`no tools/call reply. stdout: ${stdout} stderr: ${stderr}`));
        return;
      }
      resolve({ reply, payload: JSON.parse(reply.result.content[0].text) });
    }, 2200);
  });
}

test("dreamlayer_generate sends only fields the API accepts, and names the operation", async () => {
  const api = await listen(
    fakeApi({
      events: [
        {
          event: "started",
          data: {
            execution_id: "22222222-2222-4222-8222-222222222222",
            conversation_id: "33333333-3333-4333-8333-333333333333",
          },
        },
        {
          event: "asset",
          data: {
            asset_id: "44444444-4444-4444-8444-444444444444",
            download_url: "https://example.invalid/a.png",
          },
        },
        { event: "done", data: { status: "completed" } },
      ],
    }),
  );

  const { payload } = await callTool(api.url, "dreamlayer_generate", {
    prompt: "cut out the product",
    operation: "background_remove",
    input_asset_id: "11111111-1111-4111-8111-111111111111",
  });
  const execute = api.calls.find((call) => call.url === "/v1/execute");
  api.close();

  assert.ok(execute, "the tool never reached /v1/execute");
  assert.deepEqual(
    Object.keys(execute.body).sort(),
    ["input_asset_id", "operation", "prompt"],
    "a field the gateway does not declare would 422 every real call",
  );
  assert.equal(execute.body.operation, "background_remove");
  assert.equal(execute.headers["dreamlayer-version"], "1");
  assert.ok(execute.headers["idempotency-key"], "generated for the model, never demanded of it");

  assert.equal(payload.status, "completed");
  assert.equal(payload.execution_id, "22222222-2222-4222-8222-222222222222");
  assert.equal(payload.asset.asset_id, "44444444-4444-4444-8444-444444444444");
});

test("every operation the SERVER advertises is one the request may actually carry", async () => {
  // Deliberately driven from the capabilities response rather than from a list written
  // here. Restating the client's own enum and asserting it matches would check the
  // client against itself, which is how a client shipped two operations the server did
  // not implement and stayed green. A real client trusts /v1/capabilities; so does this.
  const probe = await listen(fakeApi({}));
  const { payload } = await callTool(probe.url, "dreamlayer_capabilities", {});
  probe.close();
  const advertised = payload.operations;
  assert.ok(Array.isArray(advertised) && advertised.length > 0, "capabilities listed none");

  for (const operation of advertised) {
    const api = await listen(
      fakeApi({
        events: [
          {
            event: "started",
            data: {
              execution_id: "22222222-2222-4222-8222-222222222222",
              conversation_id: "33333333-3333-4333-8333-333333333333",
            },
          },
          { event: "done", data: { status: "completed" } },
        ],
      }),
    );
    const args =
      operation === "text_to_image"
        ? { prompt: "a greenhouse", operation }
        : {
            prompt: "do the thing",
            operation,
            input_asset_id: "11111111-1111-4111-8111-111111111111",
          };
    const { payload } = await callTool(api.url, "dreamlayer_generate", args);
    const execute = api.calls.find((call) => call.url === "/v1/execute");
    api.close();

    assert.ok(execute, `${operation} never reached /v1/execute`);
    assert.equal(execute.body.operation, operation);
    assert.ok(!payload.error, `${operation} was rejected: ${JSON.stringify(payload.error)}`);
  }
});

test("an API failure returns the reason and the request id, not a bare status", async () => {
  // The Python server returned str(error), which handed a model httpx internals and no
  // basis for deciding whether to retry.
  const api = await listen(fakeApi({ status: 402, message: "insufficient credits" }));
  const { reply, payload } = await callTool(api.url, "dreamlayer_generate", {
    prompt: "a cat",
    operation: "text_to_image",
  });
  api.close();

  assert.equal(reply.result.isError, true, "a failure must be marked, not returned as success");
  assert.equal(payload.error.status, 402);
  assert.match(payload.error.detail, /insufficient credits/);
  assert.equal(payload.error.request_id, "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
  assert.match(payload.error.guidance, /credits/i);
});

test("dreamlayer_capabilities spends nothing and reports the contract", async () => {
  const api = await listen(fakeApi({}));
  const { payload } = await callTool(api.url, "dreamlayer_capabilities", {});
  const touchedExecute = api.calls.some((call) => call.url === "/v1/execute");
  api.close();

  assert.equal(payload.api_version, "1");
  assert.equal(touchedExecute, false, "capabilities must never reach the paid path");
});
