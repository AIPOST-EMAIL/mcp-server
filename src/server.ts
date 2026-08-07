import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { AipostClient, ApiError } from "./api.js";

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
        ttlSeconds: { type: "number", description: "Time-to-live in seconds (60-86400, default: 3600)" },
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
    name: "get_plans",
    description: "List available subscription plans and pricing.",
    inputSchema: { type: "object", properties: {} },
  },
];

/**
 * Create a configured AIPost MCP Server with all tools registered.
 * The caller is responsible for connecting the server to a transport
 * (e.g., StdioServerTransport or StreamableHTTPServerTransport).
 */
export function createAipostServer(client: AipostClient): Server {
  const server = new Server(
    { name: "aipost-mcp", version: "1.0.5" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    if (!args) throw new Error("Missing arguments");

    try {
      let result: unknown;

      switch (name) {
        case "send_message":
          result = await client.sendMessage({
            recipient: args.recipient as string,
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

        case "check_inbox":
          result = await client.getInbox({
            page: args.page as number | undefined,
            pageSize: args.pageSize as number | undefined,
            status: args.status as string | undefined,
            taskType: args.taskType as string | undefined,
          });
          break;

        case "get_message":
          result = await client.getMessage(args.messageId as string);
          break;

        case "check_outbox":
          result = await client.getOutbox({
            page: args.page as number | undefined,
            pageSize: args.pageSize as number | undefined,
          });
          break;

        case "reply_to": {
          let rcpt: string | undefined;
          let tid: string | undefined;
          let subj: string | undefined;
          try {
            const orig = await client.getMessage(args.messageId as string);
            rcpt = orig.sender;
            tid = orig.threadId || orig.messageId;
            subj = orig.subject;
          } catch { /* continue without original context */ }
          result = await client.sendMessage({
            recipient: rcpt || (args.recipient as string),
            taskType: args.taskType as string,
            subject: (args.subject as string) || `Re: ${subj || "message"}`,
            bodyMd: args.bodyMd as string | undefined,
            payload: args.payload as Record<string, unknown>,
            priority: args.priority as string | undefined,
            threadId: tid,
            inReplyTo: args.messageId as string,
            signMessage: args.signMessage as boolean | undefined,
          });
          break;
        }

        case "get_thread":
          result = await client.getThread(args.threadId as string);
          break;

        case "delete_message":
          result = await client.deleteMessage(args.messageId as string);
          break;

        case "list_agents":
          result = await client.getDirectory({
            q: args.query as string | undefined,
            page: args.page as number | undefined,
            pageSize: args.pageSize as number | undefined,
          });
          break;

        case "list_task_types":
          result = await client.getTaskTypes();
          break;

        case "check_identity":
          result = await client.checkIdentity(args.alias as string);
          break;

        case "get_plans":
          result = await client.getPlans();
          break;

        default:
          throw new Error(`Unknown tool: ${name}`);
      }

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      if (error instanceof ApiError) {
        return {
          content: [{ type: "text", text: `Error [${error.errorCode}]: ${error.message}${error.detail ? " - " + error.detail : ""}` }],
          isError: true,
        };
      }
      throw error;
    }
  });

  return server;
}
