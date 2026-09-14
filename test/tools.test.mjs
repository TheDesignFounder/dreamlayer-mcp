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
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
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
      const isJson = String(request.headers["content-type"] ?? "").includes("application/json");
      const body = raw && isJson ? JSON.parse(raw) : {};
      calls.push({ method: request.method, url: request.url, headers: request.headers, body });

      if (request.url === "/v1/capabilities") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            api_version: "1",
            key_mode: "live",
            operations: behaviour.operations ?? [
              "text_to_image",
              "image_to_image",
              "background_remove",
              "upscale",
            ],
          }),
        );
        return;
      }

      if (request.url === "/v1/balance") {
        response.writeHead(behaviour.balanceStatus ?? 200, {
          "content-type": "application/json",
          "cache-control": "private, no-store",
        });
        response.end(
          JSON.stringify(
            behaviour.balanceBody ?? {
              promotional: 3,
              purchased: 5,
              available: 8,
              credit_usd: "0.17",
            },
          ),
        );
        return;
      }

      if (/^\/v1\/executions\/[^/]+$/.test(request.url) && request.method === "GET") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(behaviour.execution ?? {}));
        return;
      }

      if (request.url === "/v1/execute") {
        if (behaviour.status && behaviour.status !== 200) {
          response.writeHead(behaviour.status, { "content-type": "application/json" });
          response.end(
            JSON.stringify(
              behaviour.errorBody ?? {
                error: {
                  code: "VALIDATION_FAILED",
                  message: behaviour.message ?? "nope",
                  request_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
                },
              },
            ),
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
      if (request.url === "/v1/input-assets/uploads" && request.method === "POST") {
        response.writeHead(201, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            upload_id: "11111111-1111-4111-8111-111111111111",
            upload_url:
              behaviour.uploadUrl ??
              "/v1/input-assets/uploads/11111111-1111-4111-8111-111111111111/raw",
            http_method: "PUT",
            mode: "proxied",
            content_type: "application/octet-stream",
            maximum_bytes: 209715200,
            expires_at: "2030-01-01T00:00:00Z",
          }),
        );
        return;
      }
      if (/^\/v1\/input-assets\/uploads\/[^/]+\/raw$/.test(request.url) && request.method === "PUT") {
        if (behaviour.stallUpload) return;
        response.writeHead(204).end();
        return;
      }
      if (/^\/v1\/input-assets\/uploads\/[^/]+\/finalize$/.test(request.url) && request.method === "POST") {
        response.writeHead(201, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            input_asset_id: "11111111-1111-4111-8111-111111111111",
            width: 8,
            height: 8,
            expires_at: "2030-01-01T00:00:00Z",
          }),
        );
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
function callTool(apiUrl, name, args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ENTRY], {
      env: {
        ...process.env,
        DREAMLAYER_API_KEY: "dlr_live_test_key",
        DREAMLAYER_API_URL: apiUrl,
        ...extraEnv,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let pending = "";
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      finish(new Error(`timed out. stdout: ${stdout} stderr: ${stderr}`));
    }, 12_000);
    const send = (m) => child.stdin.write(`${JSON.stringify(m)}\n`);
    child.stderr.on("data", (c) => (stderr += c.toString()));
    child.on("error", (error) => finish(error));
    child.on("close", () => {
      if (!settled) finish(new Error(`server exited without a tools/call reply. stderr: ${stderr}`));
    });
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      pending += chunk.toString();
      for (;;) {
        const newline = pending.indexOf("\n");
        if (newline < 0) break;
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (!line.trim()) continue;
        try {
          const reply = JSON.parse(line);
          if (reply.id === 1) {
            if (reply.error) throw new Error(JSON.stringify(reply.error));
            send({ jsonrpc: "2.0", method: "notifications/initialized" });
            send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });
          } else if (reply.id === 2) {
            if (reply.error) throw new Error(JSON.stringify(reply.error));
            finish(null, { reply, payload: JSON.parse(reply.result.content[0].text) });
          }
        } catch (error) { finish(error); }
      }
    });
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
  });
}



/** One process, two tools/list calls, `gap` ms apart. */
function listToolsTwice(apiUrl, gap) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ENTRY], {
      env: {
        ...process.env,
        DREAMLAYER_API_KEY: "dlr_live_test_key",
        DREAMLAYER_API_URL: apiUrl,
        // A half-second negative window leaves enough scheduling margin for the
        // retry to be observable even when the full subprocess suite is busy.
        DREAMLAYER_OPERATIONS_RETRY_MS: "500",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let pending = "";
    let first = null;
    let settled = false;
    let retryTimer = null;
    const send = (m) => child.stdin.write(`${JSON.stringify(m)}\n`);
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (retryTimer) clearTimeout(retryTimer);
      child.kill();
      if (error) reject(error);
      else resolve(value);
    };
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      pending += text;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines.filter(Boolean)) {
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id === 2 && first === null) {
          first = message.result.tools;
          // Measure the negative-cache window from the first completed request,
          // not from process spawn. Under a busy CI runner two absolute timers can
          // fire together before request 1 finishes, making the test manufacture
          // the stale-cache behavior it is supposed to detect.
          retryTimer = setTimeout(
            () => send({ jsonrpc: "2.0", id: 3, method: "tools/list" }),
            gap,
          );
        } else if (message.id === 3 && first !== null) {
          finish(null, [first, message.result.tools]);
        }
      }
    });
    child.once("error", (error) => finish(error));
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
    });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    setTimeout(() => send({ jsonrpc: "2.0", id: 2, method: "tools/list" }), 300);
    const timeout = setTimeout(
      () => finish(new Error(`missing tools/list replies. stdout: ${stdout}`)),
      12_000,
    );
  });
}

/** tools/list plus whatever the server wrote to stderr. */
function listToolsWithStderr(apiUrl) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ENTRY], {
      env: { ...process.env, DREAMLAYER_API_KEY: "dlr_live_test_key", DREAMLAYER_API_URL: apiUrl },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (c) => (stdout += c.toString()));
    child.stderr.on("data", (c) => (stderr += c.toString()));
    const send = (m) => child.stdin.write(`${JSON.stringify(m)}\n`);
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
    });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    setTimeout(() => send({ jsonrpc: "2.0", id: 2, method: "tools/list" }), 300);
    setTimeout(() => {
      child.kill();
      const reply = stdout.split("\n").filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
        .find((m) => m.id === 2);
      if (!reply) { reject(new Error(`no tools/list reply. stderr: ${stderr}`)); return; }
      resolve({ tools: reply.result.tools, stderr });
    }, 2600);
  });
}

/** Spawn the server and complete one tools/list round trip. */
function listTools(apiUrl) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ENTRY], {
      env: { ...process.env, DREAMLAYER_API_KEY: "dlr_live_test_key", DREAMLAYER_API_URL: apiUrl },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (c) => (stdout += c.toString()));
    const send = (m) => child.stdin.write(`${JSON.stringify(m)}\n`);
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
    });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    setTimeout(() => send({ jsonrpc: "2.0", id: 2, method: "tools/list" }), 300);
    setTimeout(() => {
      child.kill();
      const reply = stdout
        .split("\n")
        .filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean)
        .find((m) => m.id === 2);
      if (!reply) { reject(new Error(`no tools/list reply. stdout: ${stdout}`)); return; }
      resolve(reply.result.tools);
    }, 2600);
  });
}

/** A port nothing is listening on: bind, read it, close. */
async function freePort() {
  const s = createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
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

test("dreamlayer_upload_image sends camera RAW through staged server normalization", async () => {
  const api = await listen(fakeApi({}));
  const directory = await mkdtemp(path.join(tmpdir(), "dreamlayer-mcp-raw-"));
  const source = path.join(directory, "camera.dng");
  await writeFile(source, Buffer.from("89504e470d0a1a0a", "hex"));

  try {
    const { payload } = await callTool(api.url, "dreamlayer_upload_image", { path: source });
    const calls = api.calls.map((call) => `${call.method} ${call.url}`);

    assert.equal(payload.input_asset_id, "11111111-1111-4111-8111-111111111111");
    assert.ok(calls.includes("POST /v1/input-assets/uploads"));
    assert.ok(calls.some((value) => /PUT \/v1\/input-assets\/uploads\/[^/]+\/raw/.test(value)));
    assert.ok(calls.some((value) => /POST \/v1\/input-assets\/uploads\/[^/]+\/finalize/.test(value)));
  } finally { api.close(); }
});

test("a 200 MB upload receives a size-scaled deadline", async () => {
  const { uploadTimeoutMs } = await import("../dist/client.js");
  assert.ok(uploadTimeoutMs(200 * 1024 * 1024) > 130_000);
});

test("dreamlayer_upload_image refuses an off-origin proxied upload URL", async () => {
  const api = await listen(fakeApi({ uploadUrl: "http://127.0.0.1:9/steal" }));
  const directory = await mkdtemp(path.join(tmpdir(), "dreamlayer-mcp-origin-"));
  const source = path.join(directory, "camera.dng");
  await writeFile(source, Buffer.from("89504e470d0a1a0a", "hex"));
  const { payload } = await callTool(api.url, "dreamlayer_upload_image", { path: source });
  api.close();
  assert.match(payload.error.detail, /off-origin upload URL/);
  assert.match(payload.error.guidance, /No image job was started/);
  assert.doesNotMatch(payload.error.guidance, /idempotency/i);
});

test("a genuinely stalled staged upload is reported as retryable", async () => {
  const api = await listen(fakeApi({ stallUpload: true }));
  const directory = await mkdtemp(path.join(tmpdir(), "dreamlayer-mcp-stall-"));
  const source = path.join(directory, "camera.dng");
  await writeFile(source, Buffer.from("89504e470d0a1a0a", "hex"));
  const { payload } = await callTool(
    api.url,
    "dreamlayer_upload_image",
    { path: source },
    { DREAMLAYER_UPLOAD_TIMEOUT_MS: "100" },
  );
  api.close();
  assert.match(payload.error.detail, /staged upload stopped/);
  assert.match(payload.error.guidance, /No image job was started/);
  assert.doesNotMatch(payload.error.guidance, /idempotency/i);
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
  assert.equal(payload.error.reason, "insufficient_credits");
  assert.equal(payload.error.retryable, false);
  assert.equal(payload.error.request_id, "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
  assert.match(payload.error.guidance, /credits/i);
});

test("dreamlayer_balance reads only this authenticated key and starts no paid work", async () => {
  const api = await listen(fakeApi({}));
  const { reply, payload } = await callTool(api.url, "dreamlayer_balance", {});
  const balanceCall = api.calls.find((call) => call.url === "/v1/balance");
  const paidCall = api.calls.some((call) => call.url === "/v1/execute");
  api.close();

  assert.notEqual(reply.result.isError, true);
  assert.deepEqual(payload, {
    promotional: 3,
    purchased: 5,
    available: 8,
    credit_usd: "0.17",
  });
  assert.equal(balanceCall.method, "GET");
  assert.equal(balanceCall.headers.authorization, "Bearer dlr_live_test_key");
  assert.equal(balanceCall.headers["dreamlayer-version"], "1");
  assert.equal(balanceCall.url, "/v1/balance", "no account selector may be sent");
  assert.equal(paidCall, false);
});

test("balance rejects expanded or inconsistent state without leaking private fields", async () => {
  const api = await listen(
    fakeApi({
      balanceBody: {
        promotional: 3,
        purchased: 5,
        available: 900,
        credit_usd: "0.17",
        private_account_name: "do-not-print-this",
      },
    }),
  );
  const { reply, payload } = await callTool(api.url, "dreamlayer_balance", {});
  api.close();

  assert.equal(reply.result.isError, true);
  assert.equal(payload.error.reason, "generation_failed");
  assert.equal(payload.error.message, "DreamLayer tool failed.");
  assert.doesNotMatch(JSON.stringify(payload), /do-not-print-this/);
});

test("402, 409, and 429 retain their closed reason and retry contract", async () => {
  const cases = [
    [402, "insufficient_credits", false],
    [409, "too_many_active_jobs", true],
    [429, "rate_limited", true],
  ];
  for (const [status, reason, retryable] of cases) {
    const api = await listen(
      fakeApi({
        status,
        errorBody: {
          error: {
            code: status === 402 ? "BUDGET_EXCEEDED" : "RATE_LIMITED",
            reason,
            message: "private-model rejected secret prompt and filename.png",
            retryable,
            request_id: "99999999-9999-4999-8999-999999999999",
          },
        },
      }),
    );
    const { reply, payload } = await callTool(api.url, "dreamlayer_generate", {
      prompt: "secret prompt",
      operation: "text_to_image",
    });
    api.close();

    assert.equal(reply.result.isError, true);
    assert.equal(payload.error.reason, reason);
    assert.equal(payload.error.retryable, retryable);
    assert.equal(payload.error.request_id, "99999999-9999-4999-8999-999999999999");
    assert.doesNotMatch(JSON.stringify(payload), /private-model|secret prompt|filename\.png/);
  }
});

test("a terminal failure is reconciled from canonical state with the same taxonomy", async () => {
  const executionId = "22222222-2222-4222-8222-222222222222";
  const api = await listen(
    fakeApi({
      events: [
        {
          event: "started",
          data: {
            execution_id: executionId,
            conversation_id: "33333333-3333-4333-8333-333333333333",
          },
        },
        { event: "done", data: { status: "failed" } },
      ],
      execution: {
        execution_id: executionId,
        conversation_id: "33333333-3333-4333-8333-333333333333",
        status: "failed",
        image_job: {
          sanitized_error: {
            code: "generation_failed",
            reason: "temporarily_unavailable",
            message: "private-model raw response and secret prompt",
            retryable: true,
            request_id: "88888888-8888-4888-8888-888888888888",
          },
        },
      },
    }),
  );
  const { reply, payload } = await callTool(api.url, "dreamlayer_generate", {
    prompt: "secret prompt",
    operation: "text_to_image",
  });
  const canonicalRead = api.calls.some((call) => call.url === `/v1/executions/${executionId}`);
  api.close();

  assert.equal(reply.result.isError, true);
  assert.equal(payload.error.reason, "temporarily_unavailable");
  assert.equal(payload.error.retryable, true);
  assert.equal(payload.error.request_id, "88888888-8888-4888-8888-888888888888");
  assert.equal(canonicalRead, true);
  assert.doesNotMatch(JSON.stringify(payload), /private-model|raw response|secret prompt/);
});

test("local upload failures do not expose filenames", async () => {
  const api = await listen(fakeApi({}));
  const privatePath = "/private/tmp/customer-secret-filename.png";
  const { reply, payload } = await callTool(api.url, "dreamlayer_upload_image", {
    path: privatePath,
  });
  api.close();

  assert.equal(reply.result.isError, true);
  assert.equal(payload.error.reason, "invalid_request");
  assert.match(payload.error.message, /could not be read/);
  assert.doesNotMatch(JSON.stringify(payload), /customer-secret-filename/);
});

test("dreamlayer_capabilities spends nothing and reports the contract", async () => {
  const api = await listen(fakeApi({}));
  const { payload } = await callTool(api.url, "dreamlayer_capabilities", {});
  const touchedExecute = api.calls.some((call) => call.url === "/v1/execute");
  api.close();

  assert.equal(payload.api_version, "1");
  assert.equal(touchedExecute, false, "capabilities must never reach the paid path");
});

test("a dead stream reports the execution id instead of a bare abort", async () => {
  // Same defect as the CLI's, same root cause: a TOTAL-duration timeout on a stream.
  // A 2048px upscale takes ~150s, the cap was 130s, so the operation failed every time
  // after the server had done the work. For a model the consequence is worse than a bad
  // exit code: it gets an abort message with no execution id and no way to reason about
  // whether retrying pays twice.
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(
      `id: 1\nevent: started\ndata: ${JSON.stringify({
        execution_id: "22222222-2222-4222-8222-222222222222",
        conversation_id: "33333333-3333-4333-8333-333333333333",
      })}\n\n`,
    );
    // then silence, with no end()
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  const { reply, payload } = await callTool(
    `http://127.0.0.1:${server.address().port}`,
    "dreamlayer_generate",
    { prompt: "a cat", operation: "text_to_image" },
    { DREAMLAYER_STREAM_IDLE_MS: "400" },
  );
  server.close();

  assert.equal(reply.result.isError, true, "a dead stream is a failure, not a success");
  assert.equal(
    payload.error.execution_id,
    "22222222-2222-4222-8222-222222222222",
    "the id arrived in `started` and must survive the abort",
  );
  assert.match(payload.error.guidance, /idempotency_key/, "must warn against paying twice");
  assert.match(payload.error.guidance, /dreamlayer_status/, "must name the recovery tool");
});

test("tools/list advertises what the SERVER runs, not what this build was compiled with", async () => {
  // The failure this prevents, from production on 2026-08-21: this package advertised
  // four operations while the gateway accepted two. Every call to the missing pair
  // failed validation, and a model cannot diagnose that — an advertised-then-rejected
  // operation looks exactly like its own mistake, so it retries and rephrases against
  // something that can never work.
  //
  // The fake server here deliberately advertises a SUBSET plus a name this build has
  // never heard of, so a client echoing its own compiled list cannot pass.
  const api = await listen(
    fakeApi({ operations: ["text_to_image", "colorize"] }),
  );

  const tools = await listTools(api.url);
  api.close();

  const generate = tools.find((t) => t.name === "dreamlayer_generate");
  assert.ok(generate, "dreamlayer_generate disappeared");
  assert.deepEqual(
    generate.inputSchema.properties.operation.enum,
    ["text_to_image", "colorize"],
    "the enum must come from /v1/capabilities, not from the compiled-in list",
  );
});

test("a server that cannot be reached still lists tools, using the built-in list", async () => {
  // A model with NO tools has less to work with than one holding a slightly stale enum,
  // and the real error surfaces on the first call with a request id attached. So the
  // fallback is deliberate rather than an oversight.
  const dead = `http://127.0.0.1:${await freePort()}`;
  const tools = await listTools(dead);

  const generate = tools.find((t) => t.name === "dreamlayer_generate");
  assert.ok(generate, "an unreachable server must not produce an empty tool list");
  assert.deepEqual(generate.inputSchema.properties.operation.enum, [
    "text_to_image",
    "image_to_image",
    "background_remove",
    "upscale",
  ]);
});

test("a blip at startup does not pin the built-in list for the whole session", async () => {
  // The bug this replaces: the fallback was cached exactly like a success. An MCP server
  // is spawned once by its client and lives for hours or days, so one unreachable moment
  // during the FIRST tools/list pinned the compiled list for the entire process with
  // nothing ever retrying. The fix would have stopped working precisely when the machine
  // was briefly offline at startup, which is the likeliest moment for it to be offline.
  //
  // Server refuses once, then answers. Both calls happen in ONE process, which is the
  // whole point: the second must not be served from a remembered failure.
  let refusals = 0;
  const handler = fakeApi({ operations: ["text_to_image", "colorize"] });
  const original = handler.server.listeners("request")[0];
  handler.server.removeAllListeners("request");
  handler.server.on("request", (request, response) => {
    if (request.url === "/v1/capabilities" && refusals === 0) {
      refusals += 1;
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "unavailable" } }));
      return;
    }
    original(request, response);
  });

  const api = await listen(handler);
  const tools = await listToolsTwice(api.url, 1200);
  api.close();

  assert.equal(refusals, 1, "the server should have refused exactly once");
  const first = tools[0].find((t) => t.name === "dreamlayer_generate");
  const second = tools[1].find((t) => t.name === "dreamlayer_generate");

  // First call falls back, which is correct and deliberate.
  assert.deepEqual(first.inputSchema.properties.operation.enum, [
    "text_to_image",
    "image_to_image",
    "background_remove",
    "upscale",
  ]);
  // Second call, same process, must have retried rather than served the remembered miss.
  assert.deepEqual(
    second.inputSchema.properties.operation.enum,
    ["text_to_image", "colorize"],
    "a cached FAILURE turned a five-second outage into a session-long one",
  );
});

test("a malformed operations list is reported, not swallowed", async () => {
  // Previously the warning lived only in the catch, so an empty array or a non-array
  // produced the same silent fallback as a network failure, with nothing to tell them
  // apart when someone came to debug it.
  const api = await listen(fakeApi({ operations: [] }));
  const { tools, stderr } = await listToolsWithStderr(api.url);
  api.close();

  const generate = tools.find((t) => t.name === "dreamlayer_generate");
  assert.deepEqual(generate.inputSchema.properties.operation.enum, [
    "text_to_image",
    "image_to_image",
    "background_remove",
    "upscale",
  ]);
  assert.match(stderr, /no usable operation list/, "a malformed answer must leave a trace");
});
