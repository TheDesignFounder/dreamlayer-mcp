/**
 * The tool surface exposed to an MCP client.
 *
 * These transliterate the contract of the retired Python server's six
 * `dreamlayer_agent_*` tools. The prefix is dropped: it existed only to
 * disambiguate managed tools from local-runtime ones, and there is no local
 * runtime any more.
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { KNOWN_OPERATIONS } from "./client.js";
import type { ManagedClient, ManagedEvent, ManagedOperation } from "./client.js";
import {
  ApiError,
  StreamIdleError,
} from "./client.js";

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

/** Cap what one call returns so a long run cannot flood a client's context. */
const MAX_EVENTS_RETURNED = 256;

function ok(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

/**
 * Turn a failure into something a model can act on.
 *
 * The Python server returned `str(error)`, which leaked httpx internals into the
 * transcript and told the model nothing about whether retrying was sensible.
 */
function fail(error: unknown): ToolResult {
  if (error instanceof ApiError) {
    const guidance =
      error.status === 402
        ? "Out of credits. Buy a pack at https://platform.dreamlayer.io/console/billing."
        : error.status === 401
          ? "The API key is missing, invalid, or revoked."
          : error.status === 403
            ? "This account is not enabled for the Agent API."
            : error.retryable
              ? "Temporary. Retry with the same idempotency_key."
              : "Fix the request before retrying.";
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              error: {
                status: error.status,
                detail: error.detail,
                request_id: error.requestId,
                guidance,
              },
            },
            null,
            2,
          ),
        },
      ],
      isError: true,
    };
  }
  // A stream that went silent is the failure most likely to have ALREADY been charged
  // for: the server may have finished the job we stopped listening to. Falling through
  // to the generic branch below gave a model a bare abort message, no execution id, and
  // no basis for deciding whether a retry would pay twice.
  if (error instanceof StreamIdleError) {
    const executionId =
      error !== null && typeof error === "object"
        ? ((error as { partialOutcome?: { execution_id?: string | null } }).partialOutcome
            ?.execution_id ?? null)
        : null;
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              error: {
                detail: error.message,
                execution_id: executionId,
                guidance: executionId
                  ? "The job may still be running. Poll dreamlayer_status with this " +
                    "execution_id before retrying, or retry with the SAME idempotency_key " +
                    "so it cannot be charged twice."
                  : "Retry with the same idempotency_key so it cannot be charged twice.",
              },
            },
            null,
            2,
          ),
        },
      ],
      isError: true,
    };
  }
  const message = error instanceof Error ? error.message : "Unknown error";
  return { content: [{ type: "text", text: JSON.stringify({ error: { message } }) }], isError: true };
}

/**
 * What this BUILD knows how to name. A floor, not the truth.
 *
 * The truth is whatever the server advertises, and the two came apart in production on
 * 2026-08-21: this package shipped four operations while the gateway accepted two, so
 * every call to the missing pair failed validation. A model cannot diagnose that. An
 * operation that is advertised and then rejected looks exactly like a client bug, so it
 * retries, rephrases, and burns turns on something that can never work.
 *
 * Used only as the fallback below.
 */
const COMPILED_OPERATIONS: readonly ManagedOperation[] = KNOWN_OPERATIONS;

/**
 * A success is good for the process. A FAILURE is good for a minute.
 *
 * The first version cached both the same way, and that turned a five-second problem
 * into a day-long one. An MCP server is spawned once by its client and lives for the
 * whole session, hours or days. So a network blip, a VPN that has not finished
 * connecting, or an API that is briefly unreachable at the moment of the FIRST
 * tools/list would pin the compiled list for the entire process, with nothing ever
 * retrying. The fix would stop working precisely when the machine was briefly offline
 * at startup, which is the likeliest moment for it to be offline.
 *
 * Falling back is right. Remembering the fallback forever is not.
 */
const NEGATIVE_TTL_MS = (() => {
  const raw = Number(process.env.DREAMLAYER_OPERATIONS_RETRY_MS);
  // Overridable so a test can observe the retry without waiting a minute. Clamped, and
  // an unparseable value falls back rather than becoming NaN, which would compare false
  // against every Date.now() and retry on literally every call.
  if (!Number.isFinite(raw) || raw <= 0) return 60_000;
  return Math.min(Math.max(raw, 250), 10 * 60_000);
})();

/**
 * Short, because this runs on a path a model is waiting on.
 *
 * getCapabilities uses the ordinary request timeout, which is sized for a request that
 * does real work. Against a hanging API that would block tools/list for over two
 * minutes. Capabilities is a small JSON read: if it has not answered in five seconds it
 * is not going to, and the compiled list is a perfectly good answer in the meantime.
 */
const PROBE_TIMEOUT_MS = 5_000;

let cache: { operations: string[]; expiresAt: number } | null = null;

/**
 * The operations the SERVER says it can run, for the tool schema a model reads.
 *
 * `/v1/capabilities` is free, spends no credits, and touches no provider, so asking is
 * cheap. Asking is also the only way to be correct: a compiled-in list is a claim about
 * a deployment that may have moved since this version was published.
 *
 * Falls back to the compiled list on ANY failure, deliberately. A server that cannot
 * reach the API, or holds a revoked key, must still start and list its tools: a model
 * that gets no tools at all has less to work with than one holding a slightly stale
 * enum, and the real error surfaces on the first call with a request id attached.
 */
export async function resolveOperations(client: ManagedClient): Promise<string[]> {
  if (cache && Date.now() < cache.expiresAt) return cache.operations;

  const fallBack = (reason: string): string[] => {
    // stderr only; stdout carries JSON-RPC and nothing else.
    process.stderr.write(`dreamlayer-mcp: ${reason}, using built-in operation list\n`);
    cache = { operations: [...COMPILED_OPERATIONS], expiresAt: Date.now() + NEGATIVE_TTL_MS };
    return cache.operations;
  };

  let caps: unknown;
  try {
    caps = await Promise.race([
      client.getCapabilities(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("capabilities probe timed out")), PROBE_TIMEOUT_MS).unref?.(),
      ),
    ]);
  } catch (error) {
    return fallBack(error instanceof Error ? error.message : "could not read /v1/capabilities");
  }

  const listed = (caps as { operations?: unknown }).operations;
  // A malformed answer is reported, not swallowed. The first version only warned inside
  // the catch, so an empty array or a non-array produced the same silent fallback as a
  // network failure with nothing to distinguish them.
  if (!Array.isArray(listed) || listed.length === 0 || listed.some((o) => typeof o !== "string")) {
    return fallBack("/v1/capabilities returned no usable operation list");
  }

  cache = { operations: listed as string[], expiresAt: Number.POSITIVE_INFINITY };
  return cache.operations;
}

/** Test seam: forget what the server said. */
export function resetOperationCache(): void {
  cache = null;
}

/** Exactly the shape `tools/list` returns; deliberately looser than TOOL_DEFINITIONS,
 *  whose readonly tuple type cannot survive a map(). */
export type ListedTool = { name: string; description: string; inputSchema: unknown };

/** The tool list with `operation` narrowed to what this server actually accepts. */
export async function toolDefinitionsFor(client: ManagedClient): Promise<ListedTool[]> {
  const operations = await resolveOperations(client);
  return TOOL_DEFINITIONS.map((tool): ListedTool => {
    const property = (tool.inputSchema.properties as Record<string, unknown>).operation as
      | { enum?: unknown }
      | undefined;
    if (!property) return { name: tool.name, description: tool.description, inputSchema: tool.inputSchema };
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: {
        ...tool.inputSchema,
        properties: {
          ...tool.inputSchema.properties,
          operation: { ...property, enum: operations },
        },
      },
    };
  });
}

export const TOOL_DEFINITIONS = [
  {
    name: "dreamlayer_capabilities",
    description:
      "Inspect the DreamLayer Agent API contract and the operations this key may run. Calls no provider and spends nothing.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "dreamlayer_upload_image",
    description:
      "Upload one local image for use as a reference. Returns an input_asset_id to pass to dreamlayer_generate.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1, description: "Absolute path to a PNG, JPEG, or WEBP." },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "dreamlayer_generate",
    description:
      "Generate or edit an image and return the resulting event stream. May end asking the user a question instead of producing an image; that is not a failure. Costs one credit per finished image.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", minLength: 1, maxLength: 4000 },
        respond: {
          type: "string",
          minLength: 1,
          maxLength: 4000,
          description: "Answer a previous question. Requires conversation_id.",
        },
        conversation_id: { type: "string" },
        input_asset_id: {
          type: "string",
          description: "From dreamlayer_upload_image. Required for every operation except text_to_image.",
        },
        aspect_ratio: { type: "string", description: "One of 1:1, 16:9, 9:16, 4:3, 3:4." },
        // This enum is the COMPILED default. tools/list replaces it with whatever
        // /v1/capabilities advertises, so a model never sees an operation this server
        // will not run. See resolveOperations.
        //
        // (The old note here said the package must not be published until the gateway
        // build carrying `operation` was live. That shipped in prodbeta176 and the
        // package is published; a stale publish-blocker is exactly the comment that
        // stops someone six months from now.)
        operation: {
          type: "string",
          enum: [...COMPILED_OPERATIONS],
          description:
            "Name it to run deterministically and skip interpretation, so the request cannot come back as a question. Omit it to let DreamLayer read the prompt.",
        },
        idempotency_key: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          description: "Optional. Generated automatically. Supply the SAME one to retry safely.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "dreamlayer_execution",
    description: "Read canonical state for one execution. Use this after any uncertain response.",
    inputSchema: {
      type: "object",
      properties: { execution_id: { type: "string", minLength: 1 } },
      required: ["execution_id"],
      additionalProperties: false,
    },
  },
  {
    name: "dreamlayer_events",
    description:
      "Resume an execution's events after a drop. Pass the last event id you actually processed.",
    inputSchema: {
      type: "object",
      properties: {
        execution_id: { type: "string", minLength: 1 },
        last_event_id: { type: "string", minLength: 1 },
      },
      required: ["execution_id"],
      additionalProperties: false,
    },
  },
  {
    name: "dreamlayer_cancel",
    description: "Request cancellation of an execution before it dispatches.",
    inputSchema: {
      type: "object",
      properties: { execution_id: { type: "string", minLength: 1 } },
      required: ["execution_id"],
      additionalProperties: false,
    },
  },
] as const;

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/**
 * Drain a stream into a bounded result.
 *
 * On overflow this keeps what it has and says so, rather than throwing the batch
 * away. The execution_id survives either way, which is the whole point: the caller
 * has already been charged and must be able to resume.
 */
async function collect(stream: AsyncGenerator<ManagedEvent>): Promise<ToolResult> {
  const events: ManagedEvent[] = [];
  let truncated = false;
  try {
    for await (const event of stream) {
      if (events.length >= MAX_EVENTS_RETURNED) {
        truncated = true;
        break;
      }
      events.push(event);
    }
  } catch (error) {
    // `started` arrives within seconds carrying the execution id. Letting the error
    // propagate bare discarded it, so a model whose stream died had no way to find a
    // job that may already have been charged for. Attached rather than wrapped, so the
    // `instanceof ApiError` branch in fail() still works.
    const begun = events.find((event) => event.event === "started");
    if (error !== null && typeof error === "object") {
      (error as { partialOutcome?: { execution_id: unknown } }).partialOutcome = {
        execution_id: begun?.data.execution_id ?? null,
      };
    }
    throw error;
  }
  const started = events.find((event) => event.event === "started");
  const done = events.find((event) => event.event === "done");
  const asset = events.find((event) => event.event === "asset");
  const question = events.find((event) => event.event === "question");

  return ok({
    execution_id: started?.data.execution_id ?? null,
    conversation_id: started?.data.conversation_id ?? null,
    status: done?.data.status ?? (truncated ? "running" : "unknown"),
    asset: asset ? { asset_id: asset.data.asset_id, download_url: asset.data.download_url } : null,
    question: question ? { question_id: question.data.question_id, text: question.data.text } : null,
    truncated,
    ...(truncated
      ? { next_step: "Call dreamlayer_events with this execution_id and the last id below." }
      : {}),
    last_event_id: events.length > 0 ? events[events.length - 1]?.id ?? null : null,
    events,
  });
}

export async function callTool(
  client: ManagedClient,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  try {
    switch (name) {
      case "dreamlayer_capabilities":
        return ok(await client.getCapabilities());

      case "dreamlayer_upload_image": {
        const filePath = String(args.path ?? "");
        if (!path.isAbsolute(filePath)) {
          throw new Error("path must be absolute");
        }
        const extension = path.extname(filePath).toLowerCase();
        if (!IMAGE_EXTENSIONS.has(extension)) {
          throw new Error(`unsupported image type ${extension || "(none)"}; use PNG, JPEG, or WEBP`);
        }
        const bytes = await readFile(filePath);
        if (bytes.byteLength > MAX_UPLOAD_BYTES) {
          throw new Error(
            `image is ${Math.round(bytes.byteLength / 1024 / 1024)} MB; the limit is 20 MB`,
          );
        }
        const asset = await client.uploadInput(
          new Blob([new Uint8Array(bytes)]),
          path.basename(filePath),
        );
        return ok(asset);
      }

      case "dreamlayer_generate": {
        const { idempotency_key: supplied, ...rest } = args;
        // Generated here rather than demanded from the model. The Python server made
        // it required, so a model had to invent one, and an invented key is not a
        // stable key: the retry it is meant to protect would not match.
        const idempotencyKey = typeof supplied === "string" && supplied ? supplied : randomUUID();
        return await collect(
          client.execute(rest as Parameters<ManagedClient["execute"]>[0], { idempotencyKey }),
        );
      }

      case "dreamlayer_execution":
        return ok(await client.getExecution(String(args.execution_id)));

      case "dreamlayer_events":
        return await collect(
          client.events(
            String(args.execution_id),
            typeof args.last_event_id === "string" ? args.last_event_id : undefined,
          ),
        );

      case "dreamlayer_cancel":
        return ok(await client.cancel(String(args.execution_id)));

      default:
        throw new Error(`unknown tool ${name}`);
    }
  } catch (error) {
    return fail(error);
  }
}
