#!/usr/bin/env node

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, dirname } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AipostClient, EventStream } from "./api.js";
import { Ed25519Signer } from "./auth/signer.js";
import { SenderFilter } from "./filter.js";
import { createAipostServer } from "./server.js";

// ── CLI: --claim-key <api-key> ────────────────────────────────────────────
// Injects the key into the user's MCP client config so they don't have to
// manually find and edit the JSON file.
//
// Usage:  npx -y @aipost/mcp-server --claim-key mfo_xxx
const claimIdx = process.argv.indexOf("--claim-key");
if (claimIdx !== -1) {
  const apiKey = process.argv[claimIdx + 1];
  if (!apiKey || !apiKey.startsWith("mfo_")) {
    console.error('Usage: npx -y @aipost/mcp-server --claim-key mfo_xxx');
    console.error('  The key should start with "mfo_". Get one at https://aipost.email/register');
    process.exit(1);
  }

  // Resolve ED25519 key path per platform
  const home = homedir();
  const ed25519Path = join(home, ".ssh", "id_ed25519");

  const serverEntry = {
    command: "npx",
    args: ["-y", "@aipost/mcp-server"],
    env: {
      AIPOST_API_KEY: apiKey,
      AIPOST_ED25519_KEY_PATH: ed25519Path,
    },
  };

  // Resolve config path per platform (Claude Desktop as primary target)
  const platformPath = (() => {
    switch (platform()) {
      case "darwin":
        return join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
      case "win32":
        return join(process.env.APPDATA || join(home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
      default:
        return join(home, ".config", "Claude", "claude_desktop_config.json");
    }
  })();

  // Read existing or start fresh
  let config: any = {};
  if (existsSync(platformPath)) {
    try {
      config = JSON.parse(readFileSync(platformPath, "utf-8"));
    } catch {
      console.error(`⚠️  Could not parse existing config at ${platformPath}. Starting fresh.`);
      config = {};
    }
  }

  if (!config.mcpServers) config.mcpServers = {};

  // Merge — preserve any existing servers
  const wasExisting = !!config.mcpServers.aipost;
  config.mcpServers.aipost = serverEntry;

  // Ensure directory exists
  const dir = dirname(platformPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(platformPath, JSON.stringify(config, null, 2) + "\n", "utf-8");

  console.log(wasExisting
    ? `✅ Updated AIPost MCP Server config at:\n   ${platformPath}`
    : `✅ AIPost MCP Server config written to:\n   ${platformPath}`);
  console.log(`\n   Key: ${apiKey.slice(0, 8)}...`);
  console.log(`   ED25519 path: ${ed25519Path}`);
  console.log(`\n   Restart your MCP client (Claude Desktop / Cursor / Windsurf) to pick up the changes.`);

  process.exit(0);
}

// ── Normal MCP server startup ─────────────────────────────────────────────

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

const eventStream = API_KEY
  ? new EventStream({ apiKey: API_KEY })
  : undefined;
eventStream?.start();

const senderFilter = new SenderFilter(process.env as Record<string, string | undefined>);
const server = createAipostServer(client, eventStream, senderFilter);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[aipost-mcp] Server started (stdio)");
}

main().catch((err) => {
  console.error("[aipost-mcp] Fatal:", err);
  process.exit(1);
});
