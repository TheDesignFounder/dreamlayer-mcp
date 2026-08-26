/**
 * Hosted client for the DreamLayer Agent API.
 *
 * Deliberately a COPY of the same file in dreamlayer-cli rather than a shared package.
 * The alternative makes every capability three releases in strict order (client, then
 * CLI, then MCP) instead of one release per repo. For a client over eight endpoints
 * that trade is not worth the friction.
 *
 * Lifted from the DreamLayer runtime's TypeScript client, which is retired. The
 * validation, error sanitisation, and origin hardening are kept verbatim because they
 * were already correct; what changed is that the SSE reader is now wired to the hosted
 * client instead of the dead local-proxy class, and that timeouts and an explicit
 * redirect policy were added, which the original lacked.
 */

export type ManagedEventName =
  | "started"
  | "thinking"
  | "progress"
  | "job"
  | "question"
  | "asset"
  | "done";

export type ManagedEvent = {
  id: string | null;
  event: ManagedEventName;
  data: Record<string, unknown>;
};

/**
 * Every operation the Agent API can execute.
 *
 * REQUIRES the gateway build that added `operation` to ExecuteRequest. Against an older
 * deployment this field is rejected with 422 extra_forbidden, because the request model
 * is closed. That is a sequencing constraint, not a reason to drop it: naming the
 * operation is what stops a cutout or an upscale being re-read from the prompt and
 * coming back as a clarifying question instead of an image.
 *
 * SATISFIED 2026-08-21. prodbeta176 carries the field in the gateway AND the dispatch
 * in the workflow engine, which had been split across two releases: the gateway
 * accepted `operation` from prodbeta174 while the half that acts on it was still on
 * prodbeta172, so naming an operation returned 200 and was then inferred from prose
 * anyway. Confirmed against the deployment, not the source: the live /openapi.json
 * advertises exactly these four in both ExecuteRequest and ImageJobCreate.
 */
export const KNOWN_OPERATIONS = [
  "text_to_image",
  "image_to_image",
  "background_remove",
  "upscale",
] as const;

/**
 * Derived from the array above, not written twice.
 *
 * The first version of this declared the union by hand and pinned an array to it with
 * `satisfies`. That catches a WRONG entry and not a MISSING one, because a shorter array
 * still satisfies a wider union, so the exact drift this file exists to detect could
 * slip through the check meant to prevent it. Deriving the type makes the array the
 * single definition and the question unaskable.
 */
export type ManagedOperation = (typeof KNOWN_OPERATIONS)[number];

export type ManagedExecuteInput = {
  prompt?: string;
  respond?: string;
  conversation_id?: string;
  input_asset_id?: string;
  aspect_ratio?: string;
  /** Requires the gateway build that added it. See ManagedOperation. */
  operation?: ManagedOperation;
};

export type ManagedInputAsset = {
  input_asset_id: string;
  width: number;
  height: number;
  expires_at: string;
};

type ManagedInputUpload = {
  upload_id: string;
  upload_url: string;
  http_method: "PUT";
  mode: "proxied" | "signed";
  content_type: string;
  maximum_bytes: number;
  expires_at: string;
};

const DIRECT_INPUT_BYTES = 20 * 1024 * 1024;
const RASTER_INPUT_SUFFIXES = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const LEGACY_INPUT_SUFFIXES = new Set([
  ...RASTER_INPUT_SUFFIXES,
  ".arw", ".cr2", ".cr3", ".crw", ".dng", ".nef", ".nrw", ".orf", ".pef",
  ".raf", ".rw2", ".sr2", ".srw",
]);

export type ManagedExecution = {
  execution_id: string;
  conversation_id: string;
  status: string;
  image_job: Record<string, unknown> | null;
};

export const PUBLIC_ERROR_REASONS = [
  "invalid_request",
  "authentication_failed",
  "access_denied",
  "resource_not_found",
  "insufficient_credits",
  "conflict",
  "too_many_active_jobs",
  "rate_limited",
  "quota_exceeded",
  "content_refused",
  "temporarily_unavailable",
  "generation_failed",
] as const;

export type PublicErrorReason = (typeof PUBLIC_ERROR_REASONS)[number];

const PUBLIC_ERROR_SPECS: Record<
  PublicErrorReason,
  { readonly message: string; readonly retryable: boolean }
> = {
  invalid_request: { message: "The request could not be validated.", retryable: false },
  authentication_failed: { message: "Authentication failed.", retryable: false },
  access_denied: {
    message: "This request is not available for this account.",
    retryable: false,
  },
  resource_not_found: { message: "The requested item was not found.", retryable: false },
  insufficient_credits: {
    message: "The account has insufficient credits.",
    retryable: false,
  },
  conflict: { message: "The request conflicts with the current state.", retryable: false },
  too_many_active_jobs: {
    message: "Too many image jobs are already in progress.",
    retryable: true,
  },
  rate_limited: { message: "Too many requests. Please try again shortly.", retryable: true },
  quota_exceeded: { message: "The account quota has been reached.", retryable: false },
  content_refused: {
    message: "The request could not be completed under the service policy.",
    retryable: false,
  },
  temporarily_unavailable: {
    message: "The service is temporarily unavailable. Please try again.",
    retryable: true,
  },
  generation_failed: { message: "Image generation failed.", retryable: false },
};

const PUBLIC_ERROR_REASON_SET = new Set<string>(PUBLIC_ERROR_REASONS);

function publicReason(value: unknown): PublicErrorReason | null {
  return typeof value === "string" && PUBLIC_ERROR_REASON_SET.has(value)
    ? (value as PublicErrorReason)
    : null;
}

function reasonForStatus(status: number): PublicErrorReason {
  if (status === 400 || status === 405 || status === 422) return "invalid_request";
  if (status === 401) return "authentication_failed";
  if (status === 403) return "access_denied";
  if (status === 404) return "resource_not_found";
  if (status === 402) return "insufficient_credits";
  if (status === 409) return "conflict";
  if (status === 429) return "rate_limited";
  if (status === 502 || status === 503 || status === 504) return "temporarily_unavailable";
  return "generation_failed";
}

function defaultCode(reason: PublicErrorReason): string {
  const codes: Record<PublicErrorReason, string> = {
    invalid_request: "VALIDATION_FAILED",
    authentication_failed: "AUTHENTICATION_FAILED",
    access_denied: "FORBIDDEN",
    resource_not_found: "NOT_FOUND",
    insufficient_credits: "BUDGET_EXCEEDED",
    conflict: "CONFLICT",
    too_many_active_jobs: "RATE_LIMITED",
    rate_limited: "RATE_LIMITED",
    quota_exceeded: "BUDGET_EXCEEDED",
    content_refused: "CONTENT_REFUSED",
    temporarily_unavailable: "SERVICE_UNAVAILABLE",
    generation_failed: "INTERNAL_ERROR",
  };
  return codes[reason];
}

function statusForReason(reason: PublicErrorReason): number {
  const statuses: Record<PublicErrorReason, number> = {
    invalid_request: 422,
    authentication_failed: 401,
    access_denied: 403,
    resource_not_found: 404,
    insufficient_credits: 402,
    conflict: 409,
    too_many_active_jobs: 429,
    rate_limited: 429,
    quota_exceeded: 402,
    content_refused: 422,
    temporarily_unavailable: 503,
    generation_failed: 500,
  };
  return statuses[reason];
}

const ERROR_IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

function publicIdentifier(value: unknown): string | null {
  return typeof value === "string" && ERROR_IDENTIFIER_PATTERN.test(value) ? value : null;
}

export class ApiError extends Error {
  public readonly detail: string;
  public readonly requestId: string | null;
  public readonly code: string;
  public readonly reason: PublicErrorReason;

  constructor(
    public readonly status: number,
    surface = "DreamLayer Agent API",
    detail: string | null = null,
    /** Server-assigned id for this failure. The only handle support can search on. */
    requestId: string | null = null,
    code: string | null = null,
    reason: PublicErrorReason = reasonForStatus(status),
  ) {
    const safeDetail = detail ?? PUBLIC_ERROR_SPECS[reason].message;
    super(`${safeDetail || `${surface} request failed (${status})`}${requestId ? ` (request ${requestId})` : ""}`);
    this.name = "ApiError";
    this.detail = safeDetail;
    this.requestId = requestId;
    this.code = code ?? defaultCode(reason);
    this.reason = reason;
  }

  /** Whether retrying with the same idempotency key is worth doing. */
  get retryable(): boolean {
    return PUBLIC_ERROR_SPECS[this.reason].retryable;
  }

  /** The same stable fields exposed by REST and CLI, with no private response text. */
  toPublicEnvelope(): Record<string, unknown> {
    return {
      error: {
        code: this.code,
        reason: this.reason,
        message: this.detail,
        retryable: this.retryable,
        request_id: this.requestId,
      },
    };
  }
}

export type ManagedBalance = {
  promotional: number;
  purchased: number;
  available: number;
  credit_usd: "0.17";
};

/**
 * A stream that went silent, as distinct from a slow one.
 *
 * Thrown as a real error type because the CLI's exit codes and its retry advice are
 * driven off the error, and a bare DOMException from AbortSignal fell through to the
 * generic handler: exit 1 with no guidance, on the one failure most likely to have been
 * charged for. See ManagedApiError.retryable.
 */
export class StreamIdleError extends Error {
  readonly idleMs = STREAM_IDLE_TIMEOUT_MS;
  constructor() {
    super(
      `the stream sent nothing for ${Math.round(STREAM_IDLE_TIMEOUT_MS / 1000)}s, so the ` +
        "connection is treated as dead. The job may still be running on the server.",
    );
    this.name = "StreamIdleError";
  }
}

export class UploadTimeoutError extends Error {
  constructor() {
    super("the staged upload stopped before it completed; no image job was started");
    this.name = "UploadTimeoutError";
  }
}

const ERROR_BODY_LIMIT = 16 * 1024;
/**
 * A plain request: send, get a body back. Bounded work, so a total cap is right.
 */
const REQUEST_TIMEOUT_MS = 130_000;
const UPLOAD_MIN_BYTES_PER_SECOND = 256 * 1024;
const UPLOAD_MAX_TIMEOUT_MS = 15 * 60_000;

export function uploadTimeoutMs(bytes: number): number {
  const override = Number(process.env.DREAMLAYER_UPLOAD_TIMEOUT_MS);
  if (Number.isFinite(override) && override > 0) {
    return Math.min(Math.max(override, 100), UPLOAD_MAX_TIMEOUT_MS);
  }
  return Math.min(
    Math.max(REQUEST_TIMEOUT_MS, 60_000 + Math.ceil(bytes / UPLOAD_MIN_BYTES_PER_SECOND) * 1000),
    UPLOAD_MAX_TIMEOUT_MS,
  );
}

/**
 * A STREAM is different, and conflating the two shipped a broken `upscale`.
 *
 * AbortSignal.timeout() caps TOTAL duration. An upscale of a 2048px image takes about
 * 150s server-side, so a 130s total cap aborted every single one: a command that failed
 * 100% of the time on a normal input, while the server had done the work and charged
 * for it.
 *
 * Raising the number would fix upscale and break again on the next slower operation.
 * The right question is not "how long may a job take" (unknowable, and it is the
 * server's business) but "how long may we hear NOTHING before the connection is dead".
 * The server sends `: keepalive` comments precisely so a client can tell those apart;
 * a total-duration timeout throws that information away.
 *
 * So: idle timeout, reset on every byte received.
 */
const STREAM_IDLE_DEFAULT_MS = 90_000;

/**
 * Overridable, within bounds. Two honest reasons rather than one: a test cannot wait
 * 90 seconds to prove a timeout fires, and a user on a genuinely bad link may need
 * longer. Clamped so a typo cannot disable the guard entirely or set it to zero, and
 * an unparseable value falls back rather than becoming NaN, which would abort instantly.
 */
const STREAM_IDLE_TIMEOUT_MS = (() => {
  const raw = Number(process.env.DREAMLAYER_STREAM_IDLE_MS);
  if (!Number.isFinite(raw) || raw <= 0) return STREAM_IDLE_DEFAULT_MS;
  return Math.min(Math.max(raw, 100), 15 * 60_000);
})();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function boundedErrorBody(response: Response): Promise<string> {
  const length = Number(response.headers.get("content-length") ?? "0");
  if (!Number.isFinite(length) || length < 0 || length > ERROR_BODY_LIMIT || !response.body) {
    return "";
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let body = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return body + decoder.decode();
      total += value.byteLength;
      if (total > ERROR_BODY_LIMIT) {
        await reader.cancel();
        return "";
      }
      body += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

async function apiError(response: Response, surface = "DreamLayer Agent API"): Promise<ApiError> {
  let reason = reasonForStatus(response.status);
  let code: string | null = null;
  let requestId = publicRequestId(response.headers.get("x-request-id"));
  try {
    const raw = await boundedErrorBody(response);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (isRecord(parsed) && isRecord(parsed.error)) {
      // Treat only the closed reason/code/id fields as data. The local message table
      // deliberately ignores arbitrary remote detail so a private upstream response
      // cannot leak through a client even if a server regression serializes it.
      reason = publicReason(parsed.error.reason) ?? reason;
      code = publicIdentifier(parsed.error.code);
      requestId = publicRequestId(parsed.error.request_id) ?? requestId;
    }
  } catch {
    // A malformed or oversized response still becomes a closed, status-derived error.
  }
  return new ApiError(response.status, surface, null, requestId, code, reason);
}

const MANAGED_EVENT_NAMES = new Set<ManagedEventName>([
  "started",
  "thinking",
  "progress",
  "job",
  "question",
  "asset",
  "done",
]);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function publicRequestId(value: unknown): string | null {
  return typeof value === "string" && UUID_PATTERN.test(value) ? value : null;
}

export function managedBalance(value: unknown): ManagedBalance {
  if (!isRecord(value)) throw new Error("Invalid DreamLayer balance response");
  const exact = ["available", "credit_usd", "promotional", "purchased"];
  if (Object.keys(value).sort().join("\0") !== exact.join("\0")) {
    throw new Error("Invalid DreamLayer balance response");
  }
  for (const field of ["promotional", "purchased", "available"] as const) {
    if (!Number.isSafeInteger(value[field]) || Number(value[field]) < 0) {
      throw new Error("Invalid DreamLayer balance response");
    }
  }
  if (
    value.credit_usd !== "0.17" ||
    Number(value.available) !== Number(value.promotional) + Number(value.purchased)
  ) {
    throw new Error("Invalid DreamLayer balance response");
  }
  return {
    promotional: Number(value.promotional),
    purchased: Number(value.purchased),
    available: Number(value.available),
    credit_usd: "0.17",
  };
}

/** Convert a terminal job failure into the same safe contract used by HTTP errors. */
export function terminalExecutionError(execution: ManagedExecution): ApiError | null {
  if (!isRecord(execution.image_job) || !isRecord(execution.image_job.sanitized_error)) {
    return execution.status === "failed" ? new ApiError(500) : null;
  }
  const error = execution.image_job.sanitized_error;
  const reason = publicReason(error.reason) ?? "generation_failed";
  return new ApiError(
    statusForReason(reason),
    "DreamLayer execution",
    null,
    publicRequestId(error.request_id),
    publicIdentifier(error.code),
    reason,
  );
}

/**
 * Validate one sanitized event against the published contract.
 *
 * Deliberately strict, including rejecting UNKNOWN fields: the point of the closed
 * schema is that a field appearing where none is documented means something changed
 * server-side that a client should not silently consume.
 */
export function managedEvent(event: string, id: string | null, value: unknown): ManagedEvent {
  if (!MANAGED_EVENT_NAMES.has(event as ManagedEventName) || !isRecord(value)) {
    throw new Error("Invalid DreamLayer managed event");
  }
  const data = { ...value };
  const exact = (required: string[], optional: string[] = []): void => {
    const keys = Object.keys(data);
    if (
      !required.every((key) => keys.includes(key)) ||
      !keys.every((key) => required.includes(key) || optional.includes(key))
    ) {
      throw new Error("Invalid DreamLayer managed event fields");
    }
  };
  const uuid = (key: string): void => {
    const candidate = data[key];
    if (typeof candidate !== "string" || !UUID_PATTERN.test(candidate)) {
      throw new Error("Invalid DreamLayer managed event identifier");
    }
  };
  const text = (key: string, maximum: number): void => {
    const candidate = data[key];
    if (typeof candidate !== "string" || candidate.length === 0 || candidate.length > maximum) {
      throw new Error("Invalid DreamLayer managed event text");
    }
  };

  switch (event) {
    case "started":
      exact(["execution_id", "conversation_id"]);
      uuid("execution_id");
      uuid("conversation_id");
      break;
    case "thinking":
      exact([]);
      break;
    case "progress":
      exact(["text"]);
      text("text", 300);
      break;
    case "job":
      exact(["public_job_id", "status"]);
      uuid("public_job_id");
      if (!["queued", "running", "completed", "failed"].includes(String(data.status))) {
        throw new Error("Invalid DreamLayer managed job status");
      }
      break;
    case "question":
      exact(["question_id", "conversation_id", "text"]);
      uuid("question_id");
      uuid("conversation_id");
      text("text", 300);
      break;
    case "asset":
      exact(["asset_id", "download_url"]);
      uuid("asset_id");
      text("download_url", 500);
      break;
    case "done":
      exact(["status"], ["conversation_id", "message"]);
      if (!["needs_input", "completed", "failed", "cancelled"].includes(String(data.status))) {
        throw new Error("Invalid DreamLayer managed completion status");
      }
      if (data.conversation_id !== undefined) uuid("conversation_id");
      if (data.message !== undefined) text("message", 300);
      break;
  }
  return { id, event: event as ManagedEventName, data };
}

/** Parse a server-sent-event body into blocks. Handles multi-line data and comments. */
async function* readEventStream(
  body: ReadableStream<Uint8Array>,
  onBytes?: () => void,
): AsyncGenerator<{ event: string; id: string | null; data: unknown }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    // Any byte at all, including a `: keepalive` comment that parses to no event,
    // proves the connection is alive. That is the signal the idle timer needs.
    if (!done) onBytes?.();
    buffer += decoder.decode(value, { stream: !done });
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const lines = block.split("\n");
      const event = lines
        .find((line) => line.startsWith("event:"))
        ?.slice(6)
        .trim();
      const id =
        lines
          .find((line) => line.startsWith("id:"))
          ?.slice(3)
          .trim() ?? null;
      const data = lines
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");
      if (event && data) yield { event, id, data: JSON.parse(data) as unknown };
      boundary = buffer.indexOf("\n\n");
    }
    if (done) return;
  }
}

/**
 * Hosts this client will send a bearer key to.
 *
 * In August a build moved the endpoint default from api.dreamlayer.io to the bare
 * marketing apex, and every request carried Authorization there for two days. The
 * origin passed every cleanliness check below, because those check the SHAPE of a URL
 * and never which host it names. An allowlist is the only thing that catches a host
 * swap, which is why the gateway now has a pinned-origin test and why this mirrors it.
 *
 * DREAMLAYER_API_URL still works for a genuinely different deployment: set
 * DREAMLAYER_ALLOW_ANY_HOST=1 alongside it and accept that you are vouching for the host.
 */
const ALLOWED_HOSTS = new Set(["api.dreamlayer.io"]);

function isLoopback(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
}

function managedOrigin(value: string): string {
  if (!value || value.endsWith("?") || value.endsWith("#")) {
    throw new Error("Managed endpoint must be a clean HTTPS origin");
  }
  const parsed = new URL(value);
  if (
    parsed.username ||
    parsed.password ||
    (parsed.pathname !== "" && parsed.pathname !== "/") ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("Managed endpoint must be a clean HTTPS origin");
  }
  const loopback = isLoopback(parsed.hostname);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
    throw new Error("Managed endpoint must use HTTPS, except for exact loopback development");
  }
  const permitted =
    ALLOWED_HOSTS.has(parsed.hostname) ||
    loopback ||
    (process.env.DREAMLAYER_ALLOW_ANY_HOST ?? "").trim() === "1";
  if (!permitted) {
    throw new Error(
      `Refusing to send an API key to ${parsed.hostname}. ` +
        `Expected api.dreamlayer.io. Set DREAMLAYER_ALLOW_ANY_HOST=1 to override.`,
    );
  }
  return parsed.origin;
}

function requireEventStream(response: Response): void {
  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    throw new Error("DreamLayer managed endpoint did not return an event stream");
  }
}

export class ManagedClient {
  private readonly baseUrl: string;
  private capabilitiesPromise: Promise<Record<string, unknown>> | null = null;

  constructor(
    private readonly apiKey: string,
    baseUrl = "https://api.dreamlayer.io",
  ) {
    if (!apiKey.trim()) throw new Error("DREAMLAYER_API_KEY is required");
    this.baseUrl = managedOrigin(baseUrl);
  }

  /**
   * Run or continue an execution, yielding each validated event as it arrives.
   *
   * Streams rather than buffers. The Python server this replaces collected events into
   * a list and threw the whole list away on overflow, taking the execution ID with it,
   * so a caller could not even resume what it had already paid for.
   */
  async *execute(
    input: ManagedExecuteInput,
    options: { idempotencyKey: string },
  ): AsyncGenerator<ManagedEvent> {
    const stream = await this.fetchStream("/v1/execute", {
      method: "POST",
      headers: {
        Accept: "text/event-stream",
        "Content-Type": "application/json",
        "Idempotency-Key": options.idempotencyKey,
      },
      body: JSON.stringify(input),
    });
    yield* this.parse(stream);
  }

  /** Resume a stream after a drop. Pass the last event id you actually processed. */
  async *events(executionId: string, lastEventId?: string): AsyncGenerator<ManagedEvent> {
    const headers: Record<string, string> = { Accept: "text/event-stream" };
    if (lastEventId) headers["Last-Event-ID"] = lastEventId;
    const stream = await this.fetchStream(
      `/v1/executions/${encodeURIComponent(executionId)}/events`,
      { headers },
    );
    yield* this.parse(stream);
  }

  async getCapabilities(): Promise<Record<string, unknown>> {
    this.capabilitiesPromise ??= this.request<Record<string, unknown>>("/v1/capabilities").catch(
      (error: unknown) => {
        // Cache a successful contract for the session, but let a transient startup
        // failure retry. Remembering a rejected promise would pin the fallback forever.
        this.capabilitiesPromise = null;
        throw error;
      },
    );
    const capabilities = await this.capabilitiesPromise;
    if (capabilities.api_version !== "1") {
      throw new Error("Unsupported DreamLayer Agent API version");
    }
    return capabilities;
  }

  getExecution(executionId: string): Promise<ManagedExecution> {
    return this.request(`/v1/executions/${encodeURIComponent(executionId)}`);
  }

  async getBalance(): Promise<ManagedBalance> {
    return managedBalance(await this.request<unknown>("/v1/balance"));
  }

  cancel(executionId: string): Promise<ManagedExecution> {
    return this.request(`/v1/executions/${encodeURIComponent(executionId)}/cancel`, {
      method: "POST",
    });
  }

  listConversations(): Promise<Array<Record<string, unknown>>> {
    return this.request("/v1/conversations");
  }

  deleteConversation(conversationId: string): Promise<void> {
    return this.request(`/v1/conversations/${encodeURIComponent(conversationId)}`, {
      method: "DELETE",
    });
  }

  async uploadInput(file: Blob, filename = "input.png"): Promise<ManagedInputAsset> {
    const suffix = filename.slice(filename.lastIndexOf(".")).toLowerCase();
    const capabilities = await this.getCapabilities();
    const advertised = capabilities.supported_input_extensions;
    const supported = Array.isArray(advertised)
      ? new Set(advertised.filter((item): item is string => typeof item === "string"))
      : LEGACY_INPUT_SUFFIXES;
    if (!supported.has(suffix)) {
      throw new Error(`${filename} is not a supported image or camera RAW file`);
    }
    if (file.size > DIRECT_INPUT_BYTES || !RASTER_INPUT_SUFFIXES.has(suffix)) {
      const contentType = file.type || "application/octet-stream";
      const upload = await this.request<ManagedInputUpload>("/v1/input-assets/uploads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename, size_bytes: file.size, content_type: contentType }),
      });
      const targetUrl = new URL(upload.upload_url, `${this.baseUrl}/`);
      const headers = new Headers({ "Content-Type": upload.content_type });
      if (upload.mode === "signed") {
        headers.set("x-goog-content-length-range", `0,${upload.maximum_bytes}`);
      } else {
        if (targetUrl.origin !== new URL(this.baseUrl).origin) {
          throw new ApiError(502, "DreamLayer input upload", "refused an off-origin upload URL");
        }
        headers.set("Authorization", `Bearer ${this.apiKey}`);
        headers.set("DreamLayer-Version", "1");
      }
      let response: Response;
      try {
        response = await fetch(targetUrl, {
          method: upload.http_method,
          headers,
          body: file,
          redirect: "manual",
          signal: AbortSignal.timeout(uploadTimeoutMs(file.size)),
        });
      } catch (error) {
        if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
          throw new UploadTimeoutError();
        }
        throw error;
      }
      if (!response.ok) throw await apiError(response, "DreamLayer input upload");
      return this.request(`/v1/input-assets/uploads/${encodeURIComponent(upload.upload_id)}/finalize`, {
        method: "POST",
      });
    }
    const body = new FormData();
    body.append("file", file, filename);
    return this.request("/v1/input-assets", { method: "POST", body });
  }

  /**
   * Fetch a finished asset. Follows redirects on purpose: large images are served
   * straight from storage rather than proxied, so a client that refuses redirects
   * receives the redirect instead of the image.
   */
  async download(url: string): Promise<Uint8Array> {
    // Only attach the key when the URL is OUR origin. download_url arrives in the event
    // stream and is validated as text, so a wrong or hostile value would otherwise walk
    // off with a live credential on the very first request. Node strips Authorization
    // across a cross-origin redirect, so the hop to signed storage stays safe either way,
    // and storage URLs are pre-signed and need no header from us.
    const sameOrigin = (() => {
      try {
        return new URL(url).origin === this.baseUrl;
      } catch {
        return false;
      }
    })();
    const response = await fetch(url, {
      headers: sameOrigin ? { Authorization: `Bearer ${this.apiKey}` } : {},
      redirect: "follow",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw await apiError(response);
    return new Uint8Array(await response.arrayBuffer());
  }

  private async *parse(
    stream: { response: Response; keepAlive: () => void; finish: () => void },
  ): AsyncGenerator<ManagedEvent> {
    const { response, keepAlive, finish } = stream;
    if (!response.body) {
      finish();
      throw new Error("DreamLayer managed endpoint returned no body");
    }
    try {
      for await (const block of readEventStream(response.body, keepAlive)) {
        yield managedEvent(block.event, block.id, block.data);
      }
    } finally {
      // Also runs when the consumer breaks out of the loop early, which the CLI does
      // as soon as it sees a terminal event. Without this the timer keeps the process
      // alive for another idle period.
      finish();
    }
  }

  private async fetchStream(
    path: string,
    init: RequestInit,
  ): Promise<{ response: Response; keepAlive: () => void; finish: () => void }> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${this.apiKey}`);
    headers.set("DreamLayer-Version", "1");

    // One controller for the whole stream, armed on an IDLE clock that every received
    // byte pushes forward. The signal has to outlive the fetch() call: aborting only
    // the handshake would leave a stalled body hanging forever.
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const keepAlive = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => controller.abort(new StreamIdleError()), STREAM_IDLE_TIMEOUT_MS);
      timer.unref?.();
    };
    const finish = () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
    };

    keepAlive();
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers,
        redirect: "manual",
        signal: controller.signal,
      });
      if (!response.ok) {
        finish();
        throw await apiError(response);
      }
      requireEventStream(response);
      return { response, keepAlive, finish };
    } catch (error) {
      finish();
      throw error;
    }
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${this.apiKey}`);
    headers.set("DreamLayer-Version", "1");
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw await apiError(response);
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }
}
