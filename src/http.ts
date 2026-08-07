import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { AipostClient } from "./api.js";
import { Ed25519Signer } from "./auth/signer.js";
import { createAipostServer } from "./server.js";

const API_KEY = process.env.AIPOST_API_KEY;
const ED25519_KEY_PATH = process.env.AIPOST_ED25519_KEY_PATH;
const PORT = parseInt(process.env.PORT || "3000", 10);

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

const app = createMcpExpressApp({ host: "0.0.0.0" });
const transports: Record<string, StreamableHTTPServerTransport> = {};

const MAX_SESSIONS = 100;
function cleanupSessions() {
  const ids = Object.keys(transports);
  if (ids.length > MAX_SESSIONS) {
    const toRemove = ids.slice(0, ids.length - MAX_SESSIONS);
    for (const id of toRemove) {
      transports[id].close().catch(() => {});
      delete transports[id];
    }
  }
}

// POST — main MCP endpoint for tool calls and initialization
app.post("/mcp", async (req, res) => {
  try {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    let transport: StreamableHTTPServerTransport;

    if (sessionId && transports[sessionId]) {
      // Existing session — reuse transport
      transport = transports[sessionId];
    } else if (!sessionId && isInitializeRequest(req.body)) {
      // New session — create transport, connect fresh server
      const client = new AipostClient({ apiKey: API_KEY, signer });
      const server = createAipostServer(client);
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid: string) => {
          transports[sid] = transport;
          cleanupSessions();
        },
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    } else {
      res.status(400).json({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Bad Request: No valid session ID provided",
        },
        id: null,
      });
      return;
    }

    await transport.handleRequest(req, res, req.body);
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
  if (sessionId && transports[sessionId]) {
    try {
      await transports[sessionId].handleRequest(req, res);
    } catch (error) {
      if (!res.headersSent) {
        res.status(500).end();
      }
    }
  } else {
    res.status(404).json({ error: "Session not found. Use POST /mcp to initialize." });
  }
});

// DELETE — session termination
app.delete("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (sessionId && transports[sessionId]) {
    try {
      await transports[sessionId].handleRequest(req, res);
    } catch (error) {
      if (!res.headersSent) {
        res.status(500).end();
      }
    }
    transports[sessionId].close().catch(() => {});
    delete transports[sessionId];
  } else {
    res.status(404).json({ error: "Session not found" });
  }
});

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok", sessions: Object.keys(transports).length });
});

app.listen(PORT, "0.0.0.0", () => {
  console.error(`[aipost-mcp] HTTP server listening on port ${PORT}`);
});
