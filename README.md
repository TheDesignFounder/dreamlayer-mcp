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
| `dreamlayer_cancel` | Cancel before dispatch. |

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
