#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AipostClient, EventStream } from "./api.js";
import { Ed25519Signer } from "./auth/signer.js";
import { createAipostServer } from "./server.js";

const API_KEY = process.env.AIPOST_API_KEY || "";
const ED25519_KEY_PATH = process.env.AIPOST_ED25519_KEY_PATH;

if (!API_KEY) {
  console.error("[aipost-mcp] WARNING: No AIPOST_API_KEY set. Get one at https://aipost.email/register, then set it in your MCP client config (env) or Smithery Secrets. Tool calls will fail until a valid key is configured.");
}

const signer = ED25519_KEY_PATH
  ? new Ed25519Signer({ privateKeyPath: ED25519_KEY_PATH })
  : undefined;

if (signer?.enabled) {
  console.error("[aipost-mcp] ED25519 signing enabled");
}

const client = new AipostClient({ apiKey: API_KEY, signer });

// Start background SSE event stream for real-time inbox monitoring
const eventStream = API_KEY
  ? new EventStream({ apiKey: API_KEY })
  : undefined;
eventStream?.start();

const server = createAipostServer(client, eventStream);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[aipost-mcp] Server started (stdio)");
}

main().catch((err) => {
  console.error("[aipost-mcp] Fatal:", err);
  process.exit(1);
});
