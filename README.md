# @dreamlayer/mcp

Image generation and editing tools for MCP-compatible AI clients, backed by the
[DreamLayer Agent API](https://docs.dreamlayer.io/agent-api).

Nothing to clone, nothing to build.

## Install

Add it to your client. Claude Code:

```bash
claude mcp add dreamlayer --env DREAMLAYER_API_KEY=dlr_live_your_key -- npx -y @dreamlayer/mcp
```

Codex:

```bash
codex mcp add dreamlayer --env DREAMLAYER_API_KEY=dlr_live_your_key -- npx -y @dreamlayer/mcp
```

Cursor, or any other stdio MCP client:

```json
{
  "mcpServers": {
    "dreamlayer": {
      "command": "npx",
      "args": ["-y", "@dreamlayer/mcp"],
      "env": { "DREAMLAYER_API_KEY": "dlr_live_your_key" }
    }
  }
}
```

The key must be in the **server's own** environment. MCP clients spawn this as a
subprocess, so a key exported in your shell does not reach it. That is the most common
setup failure, and the server exits with an explanation rather than starting up broken.

Get a key at [platform.dreamlayer.io](https://platform.dreamlayer.io). A new account
starts at zero credits, and each finished image costs one.

## Tools

| Tool | What it does |
|---|---|
| `dreamlayer_capabilities` | Read the contract and the operations this key may run. Spends nothing. |
| `dreamlayer_balance` | Read this API key's promotional, purchased, and total available credits. Spends nothing. |
| `dreamlayer_upload_image` | Upload PNG, JPEG, WebP, or camera RAW (up to 200 MB) and get an `input_asset_id`. |
| `dreamlayer_generate` | Generate or edit. Returns the event stream. |
| `dreamlayer_execution` | Read canonical state for one execution. |
| `dreamlayer_events` | Resume a stream after a drop, from a last event id. |

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

Eligible accounts can create walk, run, or idle sprite bundles. Request an integer `frame_count` from 7 to 100 (default 12). Frames 1–14 cost $0.14 each; additional frames cost $0.07 each. One credit is $0.17. The total request charge rounds up to one decimal credit; displayed balances round down without changing stored funds. Check `sprite_pricing` in capabilities and approve the total with `max_credits`. A bundle includes transparent frames, sheet, atlas, preview, and import instructions. Large requests may contain a sequence rather than one seamless loop; the atlas identifies the sampling mode. Insufficient distinct frames fail without padding or interpolation. Jobs may take several minutes. Hold credits at admission, charge after complete delivery, and restore the hold if generation fails or times out. Sprite requests have no customer cancellation. Keep the execution ID to resume status.

Call `dreamlayer_upload_image`, then `dreamlayer_generate` with `operation: "sprite_sheet"`, the uploaded `input_asset_id`, `options: {action: "walk", frame_count: 12}`, and `max_credits` set to your approved limit.

Each tool call waits for a bounded interval. If the result remains active, pass its `execution_id` and `last_event_id` to `dreamlayer_events`. When completed, use `dreamlayer_download` with `execution_id` and an absolute `path` ending in `.zip`. Existing files are never overwritten.

For affordability, compare the complete rounded quote in **credits** with `available`. One tenth of a credit is $0.017. Promotional and purchased amounts are displayed rounded down separately, so their displayed sum can be 0.1 credit below `available`; stored fractions are preserved. Compare against the combined total, not that sum. The order charge rounds only once, never per frame or per tier.
