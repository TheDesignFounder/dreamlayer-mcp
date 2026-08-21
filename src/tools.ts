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

import type { ManagedClient, ManagedEvent, ManagedOperation } from "./client.js";
import { ApiError } from "./client.js";

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
            { error: { status: error.status, detail: error.detail, guidance } },
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

const OPERATIONS: ManagedOperation[] = [
  "text_to_image",
  "image_to_image",
  "background_remove",
  "upscale",
];

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
        operation: {
          type: "string",
          enum: OPERATIONS,
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
  for await (const event of stream) {
    if (events.length >= MAX_EVENTS_RETURNED) {
      truncated = true;
      break;
    }
    events.push(event);
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
