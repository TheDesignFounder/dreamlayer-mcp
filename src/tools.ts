/**
 * The tool surface exposed to an MCP client.
 *
 * These transliterate the contract of the retired Python server's six
 * `dreamlayer_agent_*` tools. The prefix is dropped: it existed only to
 * disambiguate managed tools from local-runtime ones, and there is no local
 * runtime any more.
 */
import { randomUUID } from "node:crypto";
import { openAsBlob } from "node:fs";
import { stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { KNOWN_OPERATIONS } from "./client.js";
import type { ManagedClient, ManagedEvent, ManagedOperation } from "./client.js";
import {
  ApiError,
  InputValidationError,
  RecoveryRequiredError,
  ResponseContractError,
  StreamIdleError,
  UploadTimeoutError,
  terminalExecutionError,
} from "./client.js";

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
};

/** Cap what one call returns so a long run cannot flood a client's context. */
const MAX_EVENTS_RETURNED = 256;

class ToolInputError extends Error {}
class LocalOutputError extends Error {}

function ok(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

/**
 * Turn a failure into something a model can act on.
 *
 * The Python server returned `str(error)`, which leaked httpx internals into the
 * transcript and told the model nothing about whether retrying was sensible.
 */
function fail(error: unknown, options: { uploadOnly?: boolean } = {}): ToolResult {
  if (error instanceof ApiError) {
    const guidance =
      options.uploadOnly
        ? "No image job was started. Correct the error, then retry the upload."
        : error.reason === "insufficient_credits"
        ? "Out of credits. Buy a pack at https://platform.dreamlayer.io/console/billing."
        : error.reason === "authentication_failed"
          ? "The API key is missing, invalid, or revoked."
          : error.reason === "access_denied"
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
                code: error.code,
                reason: error.reason,
                detail: error.detail,
                message: error.detail,
                retryable: error.retryable,
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
  if (error instanceof ResponseContractError) return { ...ok({ error: {
    code: "CLIENT_ERROR", reason: "response_contract_error", message: "The API response does not match this client version.",
    retryable: false, request_id: null, guidance: "Check client compatibility or contact support. Preserve the execution ID and idempotency key; do not start replacement work.",
  } }), isError: true };
  // A stream that went silent is the failure most likely to have ALREADY been charged
  // for: the server may have finished the job we stopped listening to. Falling through
  // to the generic branch below gave a model a bare abort message, no execution id, and
  // no basis for deciding whether a retry would pay twice.
  if (error instanceof StreamIdleError || error instanceof RecoveryRequiredError) {
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
                code: "SERVICE_UNAVAILABLE",
                reason: "temporarily_unavailable",
                detail: error.message,
                message: error.message,
                retryable: true,
                request_id: null,
                execution_id: executionId,
                guidance: executionId
                  ? "The job may still be running. Call dreamlayer_execution with this " +
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
  if (error instanceof UploadTimeoutError) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              error: {
                code: "SERVICE_UNAVAILABLE",
                reason: "temporarily_unavailable",
                detail: error.message,
                message: error.message,
                retryable: true,
                request_id: null,
                guidance: "No image job was started. Retry the upload.",
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
  if (error instanceof ToolInputError || error instanceof InputValidationError) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: {
              code: "VALIDATION_FAILED",
              reason: "invalid_request",
              message: error.message,
              retryable: false,
              request_id: null,
            },
          }),
        },
      ],
      isError: true,
    };
  }
  if (error instanceof LocalOutputError) return { ...ok({ error: {
    code: "CLIENT_ERROR", reason: "local_output_failed", message: "The completed output could not be saved locally.",
    retryable: true, request_id: null, guidance: "Fix the destination or choose a new path, then call dreamlayer_download with the same execution_id. Do not generate again.",
  } }), isError: true };
  // Unknown exceptions are implementation failures, not public response text. Never
  // echo their message: filesystem errors can contain local filenames, and transport
  // errors can contain URLs or other private details.
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          error: {
            code: "INTERNAL_ERROR",
            reason: "client_error",
            message: "DreamLayer tool failed.",
            retryable: false,
            request_id: null,
          },
        }),
      },
    ],
    isError: true,
  };
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
    cache = { operations: COMPILED_OPERATIONS.filter((op) => op !== "sprite_sheet"), expiresAt: Date.now() + NEGATIVE_TTL_MS };
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
export type ListedTool = { name: string; description: string; inputSchema: unknown; outputSchema: Record<string, unknown>; annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean } };

/** The tool list with `operation` narrowed to what this server actually accepts. */
export async function toolDefinitionsFor(client: ManagedClient): Promise<ListedTool[]> {
  const operations = await resolveOperations(client);
  return TOOL_DEFINITIONS.map((tool): ListedTool => {
    const shapes: Record<string, Record<string, unknown>> = {
      dreamlayer_capabilities: { api_version: { type: "string" }, operations: { type: "array", items: { type: "string" } } },
      dreamlayer_balance: { available: { type: "number" }, purchased: { type: "number" }, promotional: { type: "number" }, credit_usd: { type: "string" } },
      dreamlayer_upload_image: { input_asset_id: { type: "string" }, expires_at: { type: "string" } },
      dreamlayer_execution: { execution_id: { type: "string" }, status: { type: "string" }, image_job: { type: ["object", "null"] } },
      dreamlayer_download: { path: { type: "string" }, bytes: { type: "number" } },
    };
    const outputSchema = { type: "object", properties: {
      ...(shapes[tool.name] ?? { execution_id: { type: ["string", "null"] }, status: { type: "string" }, last_event_id: { type: ["string", "null"] }, asset: { type: ["object", "null"] }, question: { type: ["object", "null"] }, events: { type: "array", items: { type: "object" } } }),
      error: { type: "object", properties: { reason: { type: "string" }, retryable: { type: "boolean" }, request_id: { type: ["string", "null"] }, execution_id: { type: ["string", "null"] }, idempotency_key: { type: "string" } }, required: ["reason", "retryable"] },
    }, additionalProperties: true };
    const readOnly = ["dreamlayer_capabilities", "dreamlayer_balance", "dreamlayer_execution", "dreamlayer_events"].includes(tool.name);
    const annotations = { readOnlyHint: readOnly, destructiveHint: false, idempotentHint: readOnly, openWorldHint: true };
    const property = (tool.inputSchema.properties as Record<string, unknown>).operation as
      | { enum?: unknown }
      | undefined;
    if (!property) return { ...tool, annotations, outputSchema };
    return {
      name: tool.name,
      annotations,
      outputSchema,
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
      "Use before choosing an image operation or quoting a sprite job. Read supported operations, input limits and sprite_pricing for this API key. Returns the current API contract; no image input, generation or credits required. Do not use this to create an asset.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "dreamlayer_balance",
    description:
      "Use before paid image work to check available credits for this API key. Returns promotional, purchased, available and credit_usd. Compare the complete rounded quote against available; separately rounded buckets may sum to 0.1 less. Costs no credits and does not buy credits. Resolve authentication or balance errors before generation.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "dreamlayer_upload_image",
    description:
      "Use when an edit, background removal, upscale or sprite animation needs a local reference. Requires an absolute path to PNG, JPEG, WebP or supported camera RAW, up to 200 MB. Uploads that file and returns input_asset_id; starts no paid work. Reuse the asset ID for recovery. Not needed for text-to-image. If upload fails, fix the input or retry upload only.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1, description: "Absolute path to a PNG, JPEG, WEBP, or camera RAW." },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "dreamlayer_generate",
    description:
      "Use when the user needs an original image, raster logo concept, product or marketing visual, an edit, transparent cutout, upscale, or reference-based sprite animation. Starts paid work within the user's authorized scope and budget. Text-to-image needs a prompt; other operations need input_asset_id. Select operation explicitly. Image operations cost one credit; sprite beta accepts 7–100 frames and returns a ZIP. Read sprite_pricing, round the whole quote upward once to 0.1 credit and set max_credits. Returns execution_id, status, asset, question and last_event_id. needs_input is a question; running work must be resumed, not replaced. No sprite cancellation; failed/expired holds are restored. Not a vector-logo, print-validation, product-fidelity or animation-quality guarantee.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", minLength: 1, maxLength: 4000, description: "What to generate, or how to change the reference, in plain language (1–4000 characters). Required unless respond is used; text_to_image needs it, and a short statement of intent is enough for background_remove or upscale." },
        respond: {
          type: "string",
          minLength: 1,
          maxLength: 4000,
          description: "Answer a previous question. Requires conversation_id.",
        },
        conversation_id: { type: "string", description: "UUID of an existing conversation to continue, as returned by an earlier dreamlayer_generate call. Required with respond; omit to start a new conversation." },
        input_asset_id: {
          type: "string",
          description: "From dreamlayer_upload_image. Required for every operation except text_to_image.",
        },
        options: {
          type: "object",
          description: "Sprites: supply exactly one of action (legacy preset) or animation_prompt (any subject/action, including turntables). animation_mode defaults to loop for presets, once for custom prompts. Broad requests do not guarantee quality; partial transparency depends on background removal.",
          properties: {
            action: { type: "string", enum: ["walk", "run", "idle"], description: "Legacy motion preset. Use either action or animation_prompt, not both." },
            animation_prompt: { type: "string", minLength: 1, maxLength: 4000, description: "The motion to animate, in plain language (1–4000 characters), e.g. a jump or a turntable." },
            animation_mode: { type: "string", enum: ["loop", "once"], description: "loop for a seamless cycle, once for a single pass. Defaults to loop for presets and once for custom prompts." },
            frame_count: { type: "integer", minimum: 7, maximum: 100, default: 12, description: "Number of frames in the sheet (7–100). The sprite price depends only on this value." },
            frame_size: { type: "integer", enum: [32, 64, 128, 256, 512, 720, 1080], default: 512, description: "Square export canvas, not source detail. Larger exports may be enlarged. Pricing depends only on frame count." },
          },
          oneOf: [{ required: ["action"] }, { required: ["animation_prompt"] }],
          additionalProperties: false,
        },
        max_credits: { type: "number", minimum: 0.1, maximum: 100, description: "Spending cap for this request in credits (0.1–100, default 1). Image operations require exactly 1. Sprite jobs must be capped at or above the sprite_pricing quote rounded up to one decimal." },
        aspect_ratio: { type: "string", enum: ["1:1", "16:9", "9:16", "4:3", "3:4"], description: "Output aspect ratio (default 1:1)." },
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
          description: "Choose and save one key per logical request before calling. Reuse that key AND identical arguments after an uncertain response. If omitted, a generated key is returned for recovery.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "dreamlayer_execution",
    description: "Use after a timeout, rate limit or uncertain result to read the existing execution's canonical status. Requires execution_id; costs no credits. Returns state and result details, not a newly generated image. If running, wait and resume events; if completed, download. Do not replace an uncertain paid job.",
    inputSchema: {
      type: "object",
      properties: { execution_id: { type: "string", minLength: 1, description: "UUID of the execution, as returned by dreamlayer_generate." } },
      required: ["execution_id"],
      additionalProperties: false,
    },
  },
  {
    name: "dreamlayer_events",
    description:
      "Use to resume running work or a dropped stream without another generation charge. Requires execution_id; pass the last_event_id actually processed. Returns bounded events, status and recovery cursor. If still running or rate-limited, back off before polling again. Do not repeatedly call in a tight loop or submit replacement work.",
    inputSchema: {
      type: "object",
      properties: {
        execution_id: { type: "string", minLength: 1, description: "UUID of the execution, as returned by dreamlayer_generate." },
        last_event_id: { type: "string", minLength: 1, description: "Id of the last event you processed; events after it are returned. Omit to replay from the start." },
      },
      required: ["execution_id"],
      additionalProperties: false,
    },
  },
  {
    name: "dreamlayer_download",
    description: "Use when an existing execution completed or a previous download failed. Requires execution_id and an absolute new local path. Saves the finished image or sprite ZIP and returns path/bytes; starts no generation and spends no new credits. Never overwrites. For output_not_ready check status; for local_output_failed repair the path and download the same execution.",
    inputSchema: { type: "object", properties: { execution_id: { type: "string", description: "UUID of a completed execution, as returned by dreamlayer_generate." }, path: { type: "string", description: "Absolute destination path; an existing file is never overwritten." } }, required: ["execution_id", "path"], additionalProperties: false },
  },

] as const;

const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

/**
 * Drain a stream into a bounded result.
 *
 * On overflow this keeps what it has and says so, rather than throwing the batch
 * away. The execution_id survives either way, which is the whole point: the caller
 * has already been charged and must be able to resume.
 */
async function collect(
  client: ManagedClient,
  stream: AsyncGenerator<ManagedEvent>,
  executionIdHint?: string,
  cursorHint?: string,
): Promise<ToolResult> {
  const events: ManagedEvent[] = [];
  let truncated = false;
  let interrupted = false;
  try {
    for await (const event of stream) {
      if (events.length >= MAX_EVENTS_RETURNED) {
        truncated = true;
        break;
      }
      events.push(event);
    }
  } catch (error) {
    if (!(error instanceof TypeError || error instanceof StreamIdleError || error instanceof RecoveryRequiredError)) {
      const begun = events.find((event) => event.event === "started");
      if (error !== null && typeof error === "object") Object.assign(error, { partialOutcome: { execution_id: begun?.data.execution_id ?? executionIdHint ?? null, last_event_id: events.at(-1)?.id ?? cursorHint ?? null } });
      throw error;
    }
    interrupted = true;
  }
  const started = events.find((event) => event.event === "started");
  const done = events.find((event) => event.event === "done");
  const asset = events.find((event) => event.event === "asset");
  const question = events.find((event) => event.event === "question");
  const executionId = String(started?.data.execution_id ?? executionIdHint ?? "");

  // A worker can commit terminal state before its final event is persisted.
  // A bounded stream ending therefore needs the canonical state as a fallback.
  let canonical: Awaited<ReturnType<ManagedClient["getExecution"]>> | undefined;
  if (!done && executionId) {
    try {
      canonical = await client.getExecution(executionId);
    } catch {
      // Retain the known execution and cursor if the status read is unavailable.
    }
  }
  const canonicalStatus = canonical && ["completed", "failed", "cancelled"].includes(canonical.status) ? canonical.status : undefined;
  const status = done?.data.status ?? canonicalStatus ?? (executionId ? "running" : "unknown");
  const canonicalAssets = canonical?.image_job?.finished_assets;
  const canonicalAsset = Array.isArray(canonicalAssets) && canonicalAssets.length === 1 ? canonicalAssets[0] : undefined;

  if (interrupted && !done && !canonicalStatus) {
    const error = new RecoveryRequiredError("The event stream was interrupted. Execution state is uncertain.");
    Object.assign(error, { partialOutcome: { execution_id: executionId || null, last_event_id: events.at(-1)?.id ?? cursorHint ?? null } });
    throw error;
  }
  if (status === "failed" && executionId) {
    try {
      const terminal = terminalExecutionError(canonical ?? await client.getExecution(executionId));
      if (terminal) throw terminal;
    } catch (error) {
      if (error !== null && typeof error === "object") {
        (error as { partialOutcome?: { execution_id: string } }).partialOutcome = { execution_id: executionId };
      }
      throw error;
    }
  }

  return ok({
    execution_id: executionId || null,
    conversation_id: started?.data.conversation_id ?? null,
    status,
    asset: asset ? { asset_id: asset.data.asset_id, download_url: asset.data.download_url } : canonicalAsset ? {asset_id: canonicalAsset.asset_id, download_url: canonicalAsset.download_url} : null,
    question: question ? { question_id: question.data.question_id, text: question.data.text } : null,
    truncated,
    ...(!done && !canonicalStatus && executionId
      ? { next_step: "Call dreamlayer_events with this execution_id and the last id below." }
      : {}),
    last_event_id: events.length > 0 ? events[events.length - 1]?.id ?? cursorHint ?? null : cursorHint ?? null,
    events,
  });
}

async function callToolInternal(
  client: ManagedClient,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  let recoveryKey: string | undefined;
  try {
    switch (name) {
      case "dreamlayer_capabilities":
        return ok(await client.getCapabilities());

      case "dreamlayer_balance":
        return ok(await client.getBalance());

      case "dreamlayer_upload_image": {
        const filePath = String(args.path ?? "");
        if (!path.isAbsolute(filePath)) {
          throw new ToolInputError("The local image path must be absolute.");
        }
        let fileStat: Awaited<ReturnType<typeof stat>>;
        try {
          fileStat = await stat(filePath);
        } catch {
          throw new ToolInputError("The local image could not be read.");
        }
        if (fileStat.size > MAX_UPLOAD_BYTES) {
          throw new ToolInputError("The local image exceeds the 200 MB limit.");
        }
        const asset = await client.uploadInput(
          await openAsBlob(filePath),
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
        recoveryKey = idempotencyKey;
        const result = await collect(
          client,
          client.execute(rest as Parameters<ManagedClient["execute"]>[0], { idempotencyKey }),
        );
        return ok({ ...JSON.parse(result.content[0]!.text), idempotency_key: idempotencyKey });
      }

      case "dreamlayer_execution":
        return ok(await client.getExecution(String(args.execution_id)));

      case "dreamlayer_events":
        return await collect(
          client,
          client.events(
            String(args.execution_id),
            typeof args.last_event_id === "string" ? args.last_event_id : undefined,
          ),
          String(args.execution_id),
          typeof args.last_event_id === "string" ? args.last_event_id : undefined,
        );

      case "dreamlayer_download": {
        const target = String(args.path ?? "");
        if (!path.isAbsolute(target)) throw new ToolInputError("The destination must be an absolute path.");
        const state = await client.getExecution(String(args.execution_id));
        const assets = state.image_job?.finished_assets;
        if (state.status !== "completed" || !Array.isArray(assets) || assets.length !== 1 || typeof assets[0]?.download_url !== "string") throw new ToolInputError("This execution has no finished asset yet.");
        const bytes = await client.download(assets[0].download_url);
        try { await writeFile(target, bytes, { flag: "wx" }); }
        catch { throw new LocalOutputError(); }
        return ok({ path: target, bytes: bytes.length });
      }

      default:
        throw new ToolInputError("Unknown DreamLayer tool.");
    }
  } catch (error) {
    if (name === "dreamlayer_download" && !(error instanceof ToolInputError) && !(error instanceof LocalOutputError) && !(error instanceof ApiError)) error = new RecoveryRequiredError("The download was interrupted. Retry dreamlayer_download with the same execution_id; do not generate again.");
    const result = fail(error, { uploadOnly: name === "dreamlayer_upload_image" });
    const value = JSON.parse(result.content[0]!.text);
    if (recoveryKey) value.error.idempotency_key = recoveryKey;
    const partial = (error as { partialOutcome?: { execution_id?: string } } | null)?.partialOutcome;
    if (partial?.execution_id) value.error.execution_id = partial.execution_id;
    const cursor = (error as { partialOutcome?: { last_event_id?: string | null } } | null)?.partialOutcome?.last_event_id;
    if (cursor) value.error.last_event_id = cursor;
    if (name === "dreamlayer_download") {
      value.error.execution_id = args.execution_id;
      value.error.guidance = "Read dreamlayer_execution, correct any destination or access issue, then retry dreamlayer_download with the same execution_id. Do not generate again.";
    }
    return { ...ok(value), isError: true };
  }
}

/** Structured results plus the identical text payload support both new and older clients. */
export async function callTool(client: ManagedClient, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const result = await callToolInternal(client, name, args);
  return { ...result, structuredContent: JSON.parse(result.content[0]!.text) as Record<string, unknown> };
}
