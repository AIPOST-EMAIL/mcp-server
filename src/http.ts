#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { AipostClient } from "./api.js";
import { createAipostServer } from "./server.js";

const PORT = parseInt(process.env.PORT || "3000", 10);
const MAX_SESSIONS = 100;

// Warn if a server-level key is set — per‑session keys are preferred.
// The server-level key is used ONLY as a fallback when the client does not
// send an Authorization header on initialize.
const SERVER_API_KEY = process.env.AIPOST_API_KEY || "";
if (!SERVER_API_KEY) {
  console.error("[aipost-mcp] No AIPOST_API_KEY set — clients must provide their own API key via Authorization: Bearer header on initialize");
} else {
  console.error("[aipost-mcp] Server-level AIPOST_API_KEY set (fallback mode). Per-session keys via Authorization header take precedence.");
}

// Per-session state — each session has its own transport + client
interface SessionState {
  transport: StreamableHTTPServerTransport;
  client: AipostClient;
}
const sessions: Record<string, SessionState> = {};

function cleanupSessions() {
  const ids = Object.keys(sessions);
  if (ids.length > MAX_SESSIONS) {
    const toRemove = ids.slice(0, ids.length - MAX_SESSIONS);
    for (const id of toRemove) {
      sessions[id].transport.close().catch(() => {});
      delete sessions[id];
    }
  }
}

/**
 * Extract API key from the request.
 * Priority: Authorization header > meta._aipostApiKey param field
 */
function extractApiKey(req: any): string | null {
  // 1. Authorization: Bearer mfo_xxx header (standard)
  const authHeader = req.headers["authorization"] as string | undefined;
  if (authHeader?.startsWith("Bearer ")) {
    const key = authHeader.slice(7).trim();
    if (key) return key;
  }

  // 2. Meta field in initialize params (legacy / non-standard clients)
  try {
    const metaKey = req.body?.params?._meta?._aipostApiKey;
    if (typeof metaKey === "string" && metaKey.trim()) return metaKey.trim();
  } catch { /* ignore */ }

  return null;
}

const app = createMcpExpressApp({ host: "0.0.0.0" });

// OAuth Protected Resource Metadata (MCP Streamable HTTP spec §3.2)
const RESOURCE_METADATA_URL = `https://aipost.email/mcp`;
const OAUTH_METADATA = {
  resource: "https://aipost.email/mcp",
  authorization_servers: [],
  bearer_methods_supported: ["header"],
  resource_name: "AIPost MCP Server",
  resource_documentation: "https://aipost.email"
};

// POST — main MCP endpoint for tool calls and initialization
app.post("/mcp", async (req, res) => {
  try {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (sessionId && sessions[sessionId]) {
      // Existing session — reuse transport
      await sessions[sessionId].transport.handleRequest(req, res, req.body);
      return;
    }

    if (!sessionId && isInitializeRequest(req.body)) {
      // New session — extract user's API key, create per-session client
      const userApiKey = extractApiKey(req);
      const effectiveKey = userApiKey || SERVER_API_KEY;

      if (!effectiveKey) {
        res.setHeader(
          "WWW-Authenticate",
          `Bearer resource_metadata="${RESOURCE_METADATA_URL}", error="invalid_token", error_description="API key required"`
        );
        res.status(401).json({
          jsonrpc: "2.0",
          error: {
            code: -32001,
            message: "API key required. Send an Authorization: Bearer mfo_xxx header on initialize, or register at https://aipost.email/register",
          },
          id: (req.body as any)?.id ?? null,
        });
        return;
      }

      const client = new AipostClient({ apiKey: effectiveKey });
      const server = createAipostServer(client);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid: string) => {
          sessions[sid] = { transport, client };
          cleanupSessions();
        },
      });

      if (userApiKey) {
        console.error(`[aipost-mcp] New session with per-session API key`);
      }

      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    // No session and not initialize — reject
    res.status(400).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Bad Request: No valid session ID provided. Start a new session with POST /mcp (no session-id header) and an initialize request.",
      },
      id: req.body?.id ?? null,
    });
  } catch (error) {
    console.error("[aipost-mcp] Error handling MCP request:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// GET — SSE stream for server-to-client notifications
app.get("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (sessionId && sessions[sessionId]) {
    try {
      await sessions[sessionId].transport.handleRequest(req, res);
    } catch (error) {
      if (!res.headersSent) {
        res.status(500).end();
      }
    }
  } else {
    // No session — return OAuth resource metadata for discovery (Smithery, etc.)
    res.status(200).json(OAUTH_METADATA);
  }
});

// DELETE — session termination
app.delete("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (sessionId && sessions[sessionId]) {
    try {
      await sessions[sessionId].transport.handleRequest(req, res);
    } catch (error) {
      if (!res.headersSent) {
        res.status(500).end();
      }
    }
    sessions[sessionId].transport.close().catch(() => {});
    delete sessions[sessionId];
  } else {
    res.status(404).json({ error: "Session not found" });
  }
});

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok", sessions: Object.keys(sessions).length });
});

app.listen(PORT, "0.0.0.0", () => {
  console.error(`[aipost-mcp] HTTP server listening on port ${PORT}`);
  console.error("[aipost-mcp] Per-session API key mode — each client provides their own key");
});
