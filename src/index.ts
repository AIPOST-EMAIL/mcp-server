#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AipostClient } from "./api.js";
import { Ed25519Signer } from "./auth/signer.js";
import { createAipostServer } from "./server.js";

const API_KEY = process.env.AIPOST_API_KEY;
const ED25519_KEY_PATH = process.env.AIPOST_ED25519_KEY_PATH;

if (!API_KEY) {
  console.error("[aipost-mcp] AIPOST_API_KEY environment variable is required");
  process.exit(1);
}

const signer = ED25519_KEY_PATH
  ? new Ed25519Signer({ privateKeyPath: ED25519_KEY_PATH })
  : undefined;

if (signer?.enabled) {
  console.error("[aipost-mcp] ED25519 signing enabled");
}

const client = new AipostClient({ apiKey: API_KEY, signer });
const server = createAipostServer(client);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[aipost-mcp] Server started (stdio)");
}

main().catch((err) => {
  console.error("[aipost-mcp] Fatal:", err);
  process.exit(1);
});
