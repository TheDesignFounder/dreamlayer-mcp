#!/usr/bin/env node
/**
 * DreamLayer Image Agent MCP Server.
 *
 * A stdio MCP server that gives an AI client image generation and editing through the
 * DreamLayer Agent API. Everything runs against the hosted service; there is nothing to
 * clone and nothing to build.
 *
 * Replaces a Python server that required a clone of a private repository, which is the
 * wall the first external tester hit on 2026-08-20.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { ManagedClient } from "./client.js";
import { callTool, toolDefinitionsFor } from "./tools.js";

const NAME = "dreamlayer";
const VERSION = "0.1.0";

function resolveApiKey(): string {
  const key = (process.env.DREAMLAYER_API_KEY ?? "").trim();
  if (!key) {
    // Fail at startup, not at the first tool call. A client that spawned us with no key
    // should say so immediately rather than advertise six tools that all fail later.
    process.stderr.write(
      "DREAMLAYER_API_KEY is not set in this process.\n" +
        "MCP clients spawn the server as a subprocess, so a key exported in your shell\n" +
        "does not reach it. Put it in the server's own env block:\n\n" +
        '  { "command": "npx", "args": ["-y", "@dreamlayer/mcp"],\n' +
        '    "env": { "DREAMLAYER_API_KEY": "dlr_live_..." } }\n\n' +
        "Get a key at https://platform.dreamlayer.io\n",
    );
    process.exit(1);
  }
  return key;
}

async function main(): Promise<void> {
  const client = new ManagedClient(
    resolveApiKey(),
    (process.env.DREAMLAYER_API_URL ?? "https://api.dreamlayer.io").trim(),
  );

  const server = new Server(
    { name: NAME, version: VERSION },
    { capabilities: { tools: {} } },
  );

  // Asks the SERVER which operations it runs, rather than advertising a list compiled
  // into this version. On 2026-08-21 those disagreed in production: this package
  // offered four operations while the gateway accepted two, and a model cannot tell an
  // advertised-then-rejected operation apart from its own mistake. `/v1/capabilities`
  // is free and spends nothing, and a failure falls back to the built-in list rather
  // than serving no tools at all.
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: await toolDefinitionsFor(client),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    callTool(client, request.params.name, request.params.arguments ?? {}),
  );

  // stdout carries JSON-RPC and nothing else. Anything written there by accident is a
  // protocol error in the client, which is why every diagnostic above goes to stderr.
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  process.stderr.write(`dreamlayer-mcp failed to start: ${String(error)}\n`);
  process.exit(1);
});
