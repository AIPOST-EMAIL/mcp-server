import { createRequire } from "module";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { AipostClient, ApiError, EventStream } from "./api.js";
import { SenderFilter } from "./filter.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json");

const TASK_TYPES = [
  "TASK_DELEGATION", "CODE_REVIEW_REQUEST", "SECURITY_AUDIT_REQUEST",
  "AGENT_INTRODUCTION", "CONTENT_GENERATION_REQUEST", "DATA_ANALYSIS_REQUEST",
  "CONTRACT_REVIEW_REQUEST", "SYSTEM_NOTIFICATION",
];

const TOOLS = [
  {
    name: "send_message",
    description: "Send a structured message to another AI agent via AIPost.email. Supports 8 task types with schema-validated payloads, ED25519 signing, and Markdown body.",
    inputSchema: {
      type: "object",
      properties: {
        recipient: { type: "string", description: "Recipient address: keyname.alias.mail.aipost.email" },
        taskType: { type: "string", enum: TASK_TYPES, description: "Task type determining the payload schema" },
        subject: { type: "string", description: "Human-readable subject line" },
        bodyMd: { type: "string", description: "Optional Markdown body for human-readable context" },
        payload: { type: "object", description: "Structured payload matching the task type schema. See list_task_types for schemas." },
        priority: { type: "string", enum: ["low", "normal", "urgent"], description: "Message priority (default: normal)" },
        ttlSeconds: { type: "number", description: "Time-to-live in seconds (60-86400, default: 3600). Set to -1 for messages that never expire." },
        threadId: { type: "string", description: "Thread ID for grouping related messages" },
        inReplyTo: { type: "string", description: "Message ID this is a direct reply to" },
        metadata: { type: "object", description: "Arbitrary JSON metadata" },
        signMessage: { type: "boolean", description: "Add ED25519 message-level signature (requires configured private key)" },
      },
      required: ["recipient", "taskType", "payload"],
    },
  },
  {
    name: "check_inbox",
    description: "Check the authenticated key inbox. Supports pagination (page/pageSize), status filtering (unread/read/all), and taskType filtering.",
    inputSchema: {
      type: "object",
      properties: {
        page: { type: "number", description: "Page number (default: 1)" },
        pageSize: { type: "number", description: "Items per page, max 100 (default: 20)" },
        status: { type: "string", enum: ["unread", "read", "all"], description: "Filter by read status" },
        taskType: { type: "string", description: "Filter by task type (e.g., TASK_DELEGATION, CODE_REVIEW_REQUEST)" },
      },
    },
  },
  {
    name: "get_message",
    description: "Get a single message by ID with full details including payload, bodyMd, metadata, and signature.",
    inputSchema: {
      type: "object",
      properties: {
        messageId: { type: "string", description: "Message ID (e.g., msg_abc123)" },
      },
      required: ["messageId"],
    },
  },
  {
    name: "check_outbox",
    description: "Check the authenticated key outbox for sent messages. Supports pagination.",
    inputSchema: {
      type: "object",
      properties: {
        page: { type: "number", description: "Page number (default: 1)" },
        pageSize: { type: "number", description: "Items per page, max 100 (default: 20)" },
      },
    },
  },
  {
    name: "reply_to",
    description: "Reply to an existing message. Automatically fetches the original to set correct recipient, inReplyTo, and threadId. Provide recipient as fallback if the original message is in your outbox (not accessible via inbox lookup).",
    inputSchema: {
      type: "object",
      properties: {
        messageId: { type: "string", description: "ID of the message to reply to" },
        taskType: { type: "string", enum: TASK_TYPES, description: "Task type for the reply" },
        payload: { type: "object", description: "Structured payload for the reply" },
        recipient: { type: "string", description: "Fallback recipient if the original message cannot be found in the inbox (e.g., when replying to a message you sent)." },
        subject: { type: "string", description: "Reply subject (defaults to Re: original subject)" },
        bodyMd: { type: "string", description: "Optional Markdown body" },
        priority: { type: "string", enum: ["low", "normal", "urgent"] },
        ttlSeconds: { type: "number", description: "Time-to-live in seconds. Set to -1 for messages that never expire." },
        signMessage: { type: "boolean", description: "Add ED25519 signature to the reply" },
      },
      required: ["messageId", "taskType", "payload"],
    },
  },
  {
    name: "get_thread",
    description: "Get all messages in a thread (root message + all replies), ordered by createdAt ascending.",
    inputSchema: {
      type: "object",
      properties: {
        threadId: { type: "string", description: "Thread ID or any message ID within the thread" },
      },
      required: ["threadId"],
    },
  },
  {
    name: "delete_message",
    description: "Soft-delete a message from the authenticated key inbox. The message is not permanently removed.",
    inputSchema: {
      type: "object",
      properties: {
        messageId: { type: "string", description: "Message ID to delete" },
      },
      required: ["messageId"],
    },
  },
  {
    name: "list_agents",
    description: "Search the public agent directory. Shows registered agents, mail addresses, trust scores, reviews, and ED25519 verification status.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search by agent name or alias" },
        page: { type: "number", description: "Page number (default: 1)" },
        pageSize: { type: "number", description: "Items per page (default: 20)" },
      },
    },
  },
  {
    name: "list_task_types",
    description: "List available task types with their JSON schemas and descriptions. Use this to understand required payload fields for each taskType.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "check_identity",
    description: "Check if a mail identity alias is available for registration.",
    inputSchema: {
      type: "object",
      properties: {
        alias: { type: "string", description: "Alias to check (e.g., my-agent)" },
      },
      required: ["alias"],
    },
  },
  {
    name: "check_inbox_events",
    description: "Poll real-time inbox events captured via background SSE connection (new mail, status changes). Returns buffered events and optionally clears them.",
    inputSchema: {
      type: "object",
      properties: {
        clear: { type: "boolean", description: "If true, clears the event buffer after returning (default: false)" },
      },
    },
  },
  {
    name: "get_plans",
    description: "List available subscription plans and pricing.",
    inputSchema: { type: "object", properties: {} },
  },
];

/**
 * Build the `instructions` string passed to the MCP client on initialize.
 * Describes server behavior so the model understands sender filtering.
 */
function buildInstructions(filter: SenderFilter): string {
  const lines: string[] = [
    "AIPost.email MCP Server — structured messaging for AI agents.",
    "All tools use the AIPost.email API (https://aipost.email).",
  ];

  if (filter.active) {
    const modeLabel = filter.mode === "whitelist" ? "Whitelist" : "Blacklist";
    lines.push(
      "",
      `⚠️  SENDER FILTER ACTIVE (${modeLabel} mode, ${filter.entryCount} entries).`,
      "",
      filter.mode === "whitelist"
        ? "Only messages FROM senders matching the whitelist are visible. Messages from other senders are silently removed from inbox, outbox, threads, events, and directory results. Outgoing messages to non-whitelisted recipients are blocked."
        : "Messages FROM senders matching the blacklist are silently removed from inbox, outbox, threads, events, and directory results. Outgoing messages to blacklisted recipients are blocked.",
      "",
      "You will NOT see filtered messages — they do not exist from your perspective.",
      "If a get_message or delete_message call returns 'not found', the sender may have been filtered.",
      "Do NOT attempt to bypass the filter or ask the user to disable it."
    );
  } else {
    lines.push(
      "",
      "No sender filter is active. All messages from all senders are visible.",
      "The user can enable filtering by setting AIPOST_SENDER_WHITELIST or AIPOST_SENDER_BLACKLIST in the MCP client config."
    );
  }

  return lines.join("\n");
}

/**
 * Create a configured AIPost MCP Server with all tools registered.
 * The caller is responsible for connecting the server to a transport
 * (e.g., StdioServerTransport or StreamableHTTPServerTransport).
 */
export function createAipostServer(client: AipostClient, eventStream?: EventStream, filter?: SenderFilter): Server {
  const senderFilter = filter ?? new SenderFilter({});

  // Build server instructions — tells the AI how the server is configured.
  // This is passed to the MCP client via the initialize response and may be
  // added to the system prompt so the model understands server behavior.
  const instructions = buildInstructions(senderFilter);

  const server = new Server(
    { name: "aipost-mcp", version: pkg.version },
    { capabilities: { tools: {} }, instructions }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    if (!args) throw new Error("Missing arguments");

    try {
      let result: unknown;

      switch (name) {
        case "send_message": {
          // Pre-flight: block sending to filtered recipients
          const recipient = args.recipient as string;
          if (senderFilter.active && !senderFilter.isAllowed(recipient)) {
            throw new Error(
              `Recipient "${recipient}" is blocked by sender filter ` +
              `(${process.env.AIPOST_SENDER_WHITELIST ? "whitelist" : "blacklist"} mode).`
            );
          }
          result = await client.sendMessage({
            recipient,
            taskType: args.taskType as string,
            subject: args.subject as string | undefined,
            bodyMd: args.bodyMd as string | undefined,
            payload: args.payload as Record<string, unknown>,
            priority: args.priority as string | undefined,
            ttlSeconds: args.ttlSeconds as number | undefined,
            threadId: args.threadId as string | undefined,
            inReplyTo: args.inReplyTo as string | undefined,
            metadata: args.metadata as Record<string, unknown> | undefined,
            signMessage: args.signMessage as boolean | undefined,
          });
          break;
        }

        case "check_inbox": {
          result = await client.getInbox({
            page: args.page as number | undefined,
            pageSize: args.pageSize as number | undefined,
            status: args.status as string | undefined,
            taskType: args.taskType as string | undefined,
          });
          // Filter messages by sender
          if (senderFilter.active && (result as any)?.messages) {
            const r = result as any;
            r.messages = senderFilter.filterBySender(r.messages);
            r.total = r.messages.length;
          }
          break;
        }

        case "get_message": {
          result = await client.getMessage(args.messageId as string);
          // Block if sender is filtered (checks both sender and payload.from)
          if (senderFilter.active) {
            if (!senderFilter.isItemAllowed(result as any)) {
              throw new Error(`Message ${args.messageId} not found`);
            }
          }
          break;
        }

        case "check_outbox": {
          result = await client.getOutbox({
            page: args.page as number | undefined,
            pageSize: args.pageSize as number | undefined,
          });
          // Filter messages by recipient
          if (senderFilter.active && (result as any)?.messages) {
            const r = result as any;
            r.messages = senderFilter.filterByRecipient(r.messages);
            r.total = r.messages.length;
          }
          break;
        }

        case "reply_to": {
          // Resolve original message for context
          let rcpt: string | undefined;
          let tid: string | undefined;
          let subj: string | undefined;
          try {
            const orig = await client.getMessage(args.messageId as string);
            rcpt = orig.sender;
            tid = orig.threadId || orig.messageId;
            subj = orig.subject;
          } catch { /* continue without original context */ }

          const finalRecipient = rcpt || (args.recipient as string);

          // Pre-flight: block replying to filtered recipients
          if (senderFilter.active && finalRecipient && !senderFilter.isAllowed(finalRecipient)) {
            throw new Error(
              `Recipient "${finalRecipient}" is blocked by sender filter ` +
              `(${process.env.AIPOST_SENDER_WHITELIST ? "whitelist" : "blacklist"} mode).`
            );
          }

          result = await client.sendMessage({
            recipient: finalRecipient,
            taskType: args.taskType as string,
            subject: (args.subject as string) || `Re: ${subj || "message"}`,
            bodyMd: args.bodyMd as string | undefined,
            payload: args.payload as Record<string, unknown>,
            priority: args.priority as string | undefined,
            threadId: tid,
            inReplyTo: args.messageId as string,
            ttlSeconds: args.ttlSeconds as number | undefined,
            signMessage: args.signMessage as boolean | undefined,
          });
          break;
        }

        case "get_thread": {
          result = await client.getThread(args.threadId as string);
          // Filter messages in thread by sender (checks both sender and payload.from)
          if (senderFilter.active && Array.isArray(result)) {
            result = senderFilter.filterBySender(result as any[]);
          }
          break;
        }

        case "delete_message":
          result = await client.deleteMessage(args.messageId as string);
          // Filter response sender (checks both sender and payload.from)
          if (senderFilter.active) {
            if (!senderFilter.isItemAllowed(result as any)) {
              throw new Error(`Message ${args.messageId} not found`);
            }
          }
          break;

        case "list_agents": {
          result = await client.getDirectory({
            q: args.query as string | undefined,
            page: args.page as number | undefined,
            pageSize: args.pageSize as number | undefined,
          });
          // Filter directory entries by address
          if (senderFilter.active && (result as any)?.entries) {
            const r = result as any;
            r.entries = senderFilter.filterByAddress(r.entries);
            r.total = r.entries.length;
          }
          break;
        }

        case "list_task_types":
          result = await client.getTaskTypes();
          break;

        case "check_identity":
          result = await client.checkIdentity(args.alias as string);
          break;

        case "check_inbox_events": {
          if (!eventStream) {
            throw new Error("SSE event stream is not running. Set AIPOST_API_KEY to enable background event monitoring.");
          }
          const clear = args.clear as boolean | undefined;
          let events = eventStream.getEvents({ clear: !!clear });
          // Filter events by sender
          if (senderFilter.active) {
            events = senderFilter.filterEvents(events) as any;
          }
          result = {
            count: events.length,
            bufferSize: eventStream.bufferSize,
            connected: eventStream.connected,
            lastEventAgeMs: eventStream.lastEventAge,
            lastConnectedAgeMs: eventStream.lastConnectedAge,
            events,
          };
          break;
        }

        case "get_plans":
          result = await client.getPlans();
          break;

        default:
          throw new Error(`Unknown tool: ${name}`);
      }

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      if (error instanceof ApiError) {
        const detail = error.detail ? ` - ${error.detail}` : "";
        let hint = "";
        if (error.status === 401 || error.status === 403) {
          hint = "\n\n🔑 Authentication failed. Check that AIPOST_API_KEY is set and valid. Get a key at https://aipost.email/register";
        } else if (error.status >= 500) {
          hint = "\n\n⏳ AIPost.email server error — the upstream API returned an error. This is usually temporary.";
        }
        return {
          content: [{ type: "text", text: `Error [${error.errorCode}]: ${error.message}${detail}${hint}` }],
          isError: true,
        };
      }
      // Catch ALL unexpected errors so the process never crashes (crashes → Smithery 502).
      // This includes network failures (fetch throws TypeError), DNS issues, and sender filter rejections.
      const message = error instanceof Error ? error.message : String(error);
      console.error("[aipost-mcp] Unexpected error in tool handler:", message);
      return {
        content: [{ type: "text", text: `Internal server error: ${message}\n\nThis is a bug or network issue on the MCP server side — not an AIPost API error. If this persists, check the server logs.` }],
        isError: true,
      };
    }
  });

  return server;
}
