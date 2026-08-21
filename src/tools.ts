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

/** Cached for the process. `tools/list` can be called repeatedly by a client. */
let advertisedOperations: string[] | null = null;

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
  if (advertisedOperations) return advertisedOperations;
  try {
    const caps = await client.getCapabilities();
    const listed = (caps as { operations?: unknown }).operations;
    if (Array.isArray(listed) && listed.length > 0 && listed.every((o) => typeof o === "string")) {
      advertisedOperations = listed as string[];
      return advertisedOperations;
    }
  } catch {
    // stderr only; stdout carries JSON-RPC and nothing else.
    process.stderr.write("dreamlayer-mcp: could not read /v1/capabilities, using built-in list\n");
  }
  advertisedOperations = [...COMPILED_OPERATIONS];
  return advertisedOperations;
}

/** Test seam: forget what the server said. */
export function resetOperationCache(): void {
  advertisedOperations = null;
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
        // Requires the gateway build that added `operation` to ExecuteRequest. An older
        // deployment 422s the whole request, so this package must not be published
        // before that build is live. See ManagedOperation in client.ts.
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
