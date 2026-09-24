# @dreamlayer/mcp

Image generation and editing tools for MCP-compatible AI clients, backed by the
[DreamLayer Agent API](https://docs.dreamlayer.io/agent-api).

Use it for raster logo concepts, product imagery, marketing visuals, print artwork
concepts and game assets. Inspect output quality and task-specific requirements.
See the [installable agent workflows](https://github.com/TheDesignFounder/dreamlayer-agent-plugin)
for task guidance and Godot/Unity import examples.

The full workflow below uses the published sprite-capable beta. Stable `latest`
remains `0.3.0`; use the explicit version shown here.

## Install

Add it to your client. Claude Code:

```bash
claude mcp add dreamlayer --env DREAMLAYER_API_KEY=dlr_live_your_key -- npx -y @dreamlayer/mcp@0.4.0-beta.3
```

Codex:

```bash
codex mcp add dreamlayer --env DREAMLAYER_API_KEY=dlr_live_your_key -- npx -y @dreamlayer/mcp@0.4.0-beta.3
```

Cursor, or any other stdio MCP client:

```json
{
  "mcpServers": {
    "dreamlayer": {
      "command": "npx",
      "args": ["-y", "@dreamlayer/mcp@0.4.0-beta.3"],
      "env": { "DREAMLAYER_API_KEY": "dlr_live_your_key" }
    }
  }
}
```

The key must be in the **server's own** environment. MCP clients spawn this as a
subprocess, so a key exported in your shell does not reach it. That is the most common
setup failure, and the server exits with an explanation rather than starting up broken.

Get a key at [platform.dreamlayer.io](https://platform.dreamlayer.io). A new account
starts at zero credits. Ordinary image operations cost one credit each; sprite
bundles use the frame-count quote described below.

## Tools

| Tool | What it does |
|---|---|
| `dreamlayer_capabilities` | Read the contract and the operations this key may run. Spends nothing. |
| `dreamlayer_balance` | Read this API key's promotional, purchased, and total available credits. Spends nothing. |
| `dreamlayer_upload_image` | Upload PNG, JPEG, WebP, or camera RAW (up to 200 MB) and get an `input_asset_id`. |
| `dreamlayer_generate` | Generate or edit. Returns the event stream. |
| `dreamlayer_execution` | Read canonical state for one execution. |
| `dreamlayer_events` | Resume a stream after a drop, from a last event id. |
| `dreamlayer_download` | Save a completed execution to a new local path without generating again. |

## Operations

Omit `operation` and DreamLayer reads the prompt, which may come back asking a
clarifying question. Name it and that inference is skipped entirely.

| `operation` | Needs an image | Result |
|---|---|---|
| `text_to_image` | No | A new image from the prompt |
| `image_to_image` | Yes | The reference, edited as described |
| `background_remove` | Yes | The subject on transparency |
| `upscale` | Yes | Twice the width and height |

`upscale` doubles each side and finished images are capped at 4096 per side, so the
longest side of your input must be 2048 or less. A larger one is refused before it
costs a credit.

## Behaviour worth knowing

**A question is not a failure.** An ambiguous prompt returns a `question` event ending
in `needs_input`. Answer it by calling `dreamlayer_generate` again with `respond` and
the `conversation_id`.

**Retries are safe if you reuse the key.** An `idempotency_key` is generated for you.
Pass the same one back to retry after an uncertain response and the original result
replays rather than paying twice.

**Long runs are truncated, not lost.** A stream over 256 events returns what it has,
marks `truncated`, and gives you the `execution_id` and last event id to resume from.

**Errors are stable and provider-neutral.** Error tool results include `code`, `reason`,
`message`, `retryable`, and `request_id`, matching REST and the CLI. A model should branch
on `reason` and `retryable`, never message text. The response excludes prompts, local
filenames, asset URLs, provider details, credentials, and raw upstream responses.

## Requirements

Node.js 22.12 or later.

## License

MIT. See LICENSE and NOTICE.

## Sprite-sheet beta

Sprite requests accept exactly one of `options.animation_prompt` (1–4000 characters) or an `options.action` preset (`walk`, `run`, `idle`). Custom prompts can describe characters, creatures, objects, effects or 360° turntables. `animation_mode` is `loop` or `once`; presets default to loop, custom prompts to once. For a turntable, request a stationary camera and rotating subject. Broad requests do not guarantee correct motion, unseen details or successful effect transparency.

Request integer `frame_count` 7–100 (default 12) and `frame_size` 32, 64, 128, 256, 512, 720 or 1080 (default 512). These are square export canvases; a larger export does not guarantee additional detail. Aspect ratio and shared alignment are preserved with transparent padding. A bundle contains transparent PNG frames, sheet, atlas, preview and import instructions, including each frame's playback duration. Choose a repeating loop or a one-time action with a beginning and ending. If the requested number of distinct frames cannot be delivered, the job fails and held credits are returned. Translucent effects can lose detail or fail; small exports are not automatically pixel art.

Pricing is unchanged across sizes: frames 1–14 cost $0.14 each; additional frames $0.07 each. One credit is $0.17. Round the complete order upward once to a tenth of a credit. Check `sprite_pricing` in capabilities and approve the quote with `max_credits`. Credits are held during processing, settled after complete delivery and restored on failure/timeout. There is no customer cancellation. Keep the execution ID to resume status. Custom requests need the matching broad-animation server release; older servers reject them. New live generation quality, 100-frame duration and actual cost remain unverified.

Call `dreamlayer_upload_image`, then `dreamlayer_generate` with `operation: "sprite_sheet"`, the uploaded `input_asset_id`, `options: {action: "walk", frame_count: 12}`, and `max_credits` set to your approved limit.

Each tool call waits for a bounded interval. If the result remains active, pass its `execution_id` and `last_event_id` to `dreamlayer_events`. When completed, use `dreamlayer_download` with `execution_id` and an absolute `path` ending in `.zip`. Existing files are never overwritten.

For affordability, compare the complete rounded quote in **credits** with `available`. One tenth of a credit is $0.017. Promotional and purchased amounts are displayed rounded down separately, so their displayed sum can be 0.1 credit below `available`; stored fractions are preserved. Compare against the combined total, not that sum. The order charge rounds only once, never per frame or per tier.

## Tool discovery and recovery

Read `tools/list` for descriptions, input schemas, and operation availability. Read-only
calls are marked with `readOnlyHint`; upload, generation, and local download are not.
These annotations describe effects, not permission grants. Generation starts paid work.

Every tool returns `structuredContent` plus the same JSON serialized in a text block for
older clients. Failures set `isError: true`. Generation results and errors include the
idempotency key, including when the server generated it for you. Choose and save your own
key before calling when you need recovery even after the MCP process itself is lost.

After interruption, call `dreamlayer_execution` with the saved execution ID, then
`dreamlayer_events` with the last processed event ID. Retrieve completed work with
`dreamlayer_download`. Never start a replacement generation merely because the stream
closed. Keep the same uploaded asset ID and identical arguments when replaying a key.

[MCP setup](https://docs.dreamlayer.io/mcp/index) ·
[API overview](https://docs.dreamlayer.io/agent-api) ·
[Execution recovery](https://docs.dreamlayer.io/agent-api/jobs-and-events)

Abrupt stream failures trigger a canonical status read. If state is still uncertain,
the error is `temporarily_unavailable` with recovery guidance and the known execution
ID, cursor and retry key. `local_output_failed` means a completed output could not be
written: fix the path and retry `dreamlayer_download`, not `dreamlayer_generate`.
Client-side input validation uses `invalid_request`; other unclassified client failures
use `client_error` and are not evidence that generation failed.

## Error handling updates in beta.3

Malformed event payloads return `response_contract_error` with `retryable: false`, preserving the execution ID, last event ID and idempotency key when known. Check client compatibility or contact support; do not submit replacement work. Interrupted network streams still reconcile canonical state.
