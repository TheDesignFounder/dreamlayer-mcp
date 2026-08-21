/**
 * Hosted client for the DreamLayer Agent API.
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

/** Every operation the Agent API can execute. Omit it and DreamLayer reads the prompt. */
export type ManagedOperation =
  | "text_to_image"
  | "image_to_image"
  | "background_remove"
  | "upscale";

export type ManagedExecuteInput = {
  prompt?: string;
  respond?: string;
  conversation_id?: string;
  input_asset_id?: string;
  aspect_ratio?: string;
  operation?: ManagedOperation;
};

export type ManagedInputAsset = {
  input_asset_id: string;
  width: number;
  height: number;
  expires_at: string;
};

export type ManagedExecution = {
  execution_id: string;
  conversation_id: string;
  status: string;
  image_job: Record<string, unknown> | null;
};

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    surface = "DreamLayer Agent API",
    public readonly detail: string | null = null,
  ) {
    super(detail ?? `${surface} request failed (${status})`);
    this.name = "ApiError";
  }

  /** Whether retrying with the same idempotency key is worth doing. */
  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

const ERROR_BODY_LIMIT = 16 * 1024;
const ERROR_DETAIL_LIMIT = 300;
const REQUEST_TIMEOUT_MS = 130_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizedErrorDetail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized ? normalized.slice(0, ERROR_DETAIL_LIMIT) : null;
}

async function apiError(response: Response, surface = "DreamLayer Agent API"): Promise<ApiError> {
  let detail: string | null = null;
  try {
    const length = Number(response.headers.get("content-length") ?? "0");
    if (!Number.isFinite(length) || length < 0 || length > ERROR_BODY_LIMIT) {
      return new ApiError(response.status, surface);
    }
    const parsed = JSON.parse(await response.text()) as unknown;
    if (isRecord(parsed)) detail = sanitizedErrorDetail(parsed.detail);
  } catch {
    detail = null;
  }
  return new ApiError(response.status, surface, detail);
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
): AsyncGenerator<{ event: string; id: string | null; data: unknown }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
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
  const loopback =
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "localhost" ||
    parsed.hostname === "[::1]";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
    throw new Error("Managed endpoint must use HTTPS, except for exact loopback development");
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
    const response = await this.fetchStream("/v1/execute", {
      method: "POST",
      headers: {
        Accept: "text/event-stream",
        "Content-Type": "application/json",
        "Idempotency-Key": options.idempotencyKey,
      },
      body: JSON.stringify(input),
    });
    yield* this.parse(response);
  }

  /** Resume a stream after a drop. Pass the last event id you actually processed. */
  async *events(executionId: string, lastEventId?: string): AsyncGenerator<ManagedEvent> {
    const headers: Record<string, string> = { Accept: "text/event-stream" };
    if (lastEventId) headers["Last-Event-ID"] = lastEventId;
    const response = await this.fetchStream(
      `/v1/executions/${encodeURIComponent(executionId)}/events`,
      { headers },
    );
    yield* this.parse(response);
  }

  async getCapabilities(): Promise<Record<string, unknown>> {
    const capabilities = await this.request<Record<string, unknown>>("/v1/capabilities");
    if (capabilities.api_version !== "1") {
      throw new Error("Unsupported DreamLayer Agent API version");
    }
    return capabilities;
  }

  getExecution(executionId: string): Promise<ManagedExecution> {
    return this.request(`/v1/executions/${encodeURIComponent(executionId)}`);
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

  uploadInput(file: Blob, filename = "input.png"): Promise<ManagedInputAsset> {
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
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
      redirect: "follow",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw await apiError(response);
    return new Uint8Array(await response.arrayBuffer());
  }

  private async *parse(response: Response): AsyncGenerator<ManagedEvent> {
    if (!response.body) throw new Error("DreamLayer managed endpoint returned no body");
    for await (const block of readEventStream(response.body)) {
      yield managedEvent(block.event, block.id, block.data);
    }
  }

  private async fetchStream(path: string, init: RequestInit): Promise<Response> {
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
    requireEventStream(response);
    return response;
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
