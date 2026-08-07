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
const BOOT_ID = randomUUID().slice(0, 8);

console.error(`[aipost-mcp] ========================================`);
console.error(`[aipost-mcp] HTTP server starting (boot ${BOOT_ID})`);
console.error(`[aipost-mcp] Port: ${PORT}`);
console.error(`[aipost-mcp] Server API key: ${SERVER_API_KEY ? "SET (fallback enabled)" : "NOT SET (per-session keys required)"}`);
console.error(`[aipost-mcp] Auth mode: ${SERVER_API_KEY ? "hybrid (server fallback + per-session)" : "per-session only"}`);
console.error(`[aipost-mcp] ========================================`);

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

/**
 * Build OAuth Protected Resource Metadata dynamically from the request.
 * The `resource` field MUST match the server's actual URL exactly,
 * and `authorization_servers` MUST be non-empty for Smithery to
 * recognize that OAuth is properly advertised (RFC 9728 §3.3).
 *
 * IMPORTANT: Smithery proxies requests internally over HTTP, so
 * req.protocol / X-Forwarded-Proto may report "http" even though the
 * public-facing URL is https. We force https for any non-localhost host.
 */
function buildOAuthMetadata(req: any) {
  const host = req.headers["host"] || `localhost:${PORT}`;
  // Always use https for production hosts. Smithery, Cloud Run, Fly, etc.
  // all terminate TLS at the edge and forward internally over http.
  const isLocal = host.startsWith("localhost") || host.startsWith("127.") || host.startsWith("[::1]");
  const protocol = isLocal ? "http" : "https";
  const resource = `${protocol}://${host}/mcp`;
  return {
    resource,
    authorization_servers: [
      "https://api.smithery.ai",           // Smithery OAuth server
      "https://auth.smithery.ai",          // Smithery OAuth (alt)
    ],
    bearer_methods_supported: ["header"],
    resource_name: "AIPost MCP Server",
    resource_documentation: "https://aipost.email",
  };
}

// RFC 9728 §3.3 — OAuth Protected Resource Metadata
// Must return dynamic resource URL matching the actual Host header,
// and non-empty authorization_servers so Smithery recognizes OAuth.
app.get("/.well-known/oauth-protected-resource", (req, res) => {
  res.json(buildOAuthMetadata(req));
});

// POST — main MCP endpoint for tool calls and initialization
app.post("/mcp", async (req, res) => {
  try {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const method = (req.body as any)?.method || "unknown";

    // Log every request at debug level so we can trace Smithery → server communication
    console.error(`[aipost-mcp] <- POST /mcp method=${method} session=${sessionId || "none"} hasAuth=${!!req.headers["authorization"]}`);

    if (sessionId && sessions[sessionId]) {
      // Existing session — reuse transport
      await sessions[sessionId].transport.handleRequest(req, res, req.body);
      return;
    }

    if (!sessionId && isInitializeRequest(req.body)) {
      // New session — require API key at initialization so Smithery prompts
      // the user to configure AIPOST_API_KEY in Secrets / Environment Variables.
      const userApiKey = extractApiKey(req);
      const effectiveKey = userApiKey || SERVER_API_KEY;
      console.error(`[aipost-mcp] Initialize: userApiKey=${!!userApiKey} serverFallback=${!!SERVER_API_KEY} effective=${!!effectiveKey}`);

      if (!effectiveKey) {
        console.error(`[aipost-mcp] Rejected session: no API key provided (server fallback also unavailable)`);
        const metadata = buildOAuthMetadata(req);
        res.setHeader(
          "WWW-Authenticate",
          `Bearer resource_metadata="${metadata.resource}", error="invalid_token", error_description="AIPOST_API_KEY required"`
        );
        res.status(401).json({
          jsonrpc: "2.0",
          error: {
            code: -32001,
            message: [
              "API key required to use AIPost MCP Server.",
              "",
              "How to fix:",
              "1. If connecting via Smithery: the server developer must add AIPOST_API_KEY in Smithery Secrets,",
              "   or the smithery.yaml configSchema must be configured so you can enter your own key.",
              "2. If connecting directly: add an Authorization: Bearer <key> header to initialize requests.",
              "3. Get a free API key at https://aipost.email/register",
            ].join("\n"),
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
      } else {
        console.error(`[aipost-mcp] New session without API key (tools will require auth)`);
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
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`[aipost-mcp] Unhandled error in POST /mcp: ${detail}`, error instanceof Error ? error.stack : "");
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: `Internal server error: ${detail}`,
          data: { bootId: BOOT_ID },
        },
        id: (req.body as any)?.id ?? null,
      });
    }
  }
});

// GET — SSE stream for server-to-client notifications
app.get("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  console.error(`[aipost-mcp] <- GET /mcp session=${sessionId || "none"}`);
  if (sessionId && sessions[sessionId]) {
    try {
      await sessions[sessionId].transport.handleRequest(req, res);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[aipost-mcp] Error in GET /mcp (SSE): ${detail}`);
      if (!res.headersSent) {
        res.status(500).end();
      }
    }
  } else {
    // No session — return OAuth resource metadata for discovery (Smithery, etc.)
    res.status(200).json(buildOAuthMetadata(req));
  }
});

// DELETE — session termination
app.delete("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  console.error(`[aipost-mcp] <- DELETE /mcp session=${sessionId || "none"}`);
  if (sessionId && sessions[sessionId]) {
    try {
      await sessions[sessionId].transport.handleRequest(req, res);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[aipost-mcp] Error in DELETE /mcp: ${detail}`);
      if (!res.headersSent) {
        res.status(500).end();
      }
    }
    sessions[sessionId].transport.close().catch(() => {});
    delete sessions[sessionId];
    console.error(`[aipost-mcp] Session ${sessionId} terminated`);
  } else {
    res.status(404).json({ error: "Session not found" });
  }
});

// Health check — includes diagnostics for debugging cloud deployments
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    bootId: BOOT_ID,
    sessions: Object.keys(sessions).length,
    maxSessions: MAX_SESSIONS,
    serverApiKey: !!SERVER_API_KEY,
    authMode: SERVER_API_KEY ? "hybrid" : "per-session",
    uptime: Math.floor(process.uptime()),
    nodeVersion: process.version,
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.error(`[aipost-mcp] HTTP server listening on port ${PORT} (0.0.0.0)`);
  console.error(`[aipost-mcp] Endpoints: POST /mcp | GET /mcp | DELETE /mcp | GET /health`);
  console.error(`[aipost-mcp] OAuth metadata: GET /.well-known/oauth-protected-resource`);
  console.error(`[aipost-mcp] Ready for connections. Boot ID: ${BOOT_ID}`);
});
