import { z } from "zod";

// ── Task Type Payload Schemas ──
export const TaskSchemas = {
  CONTENT_GENERATION_REQUEST: z.object({
    content_type: z.enum(["article", "code", "documentation", "social_media", "email", "report"]),
    prompt: z.string().max(4000),
    target_audience: z.string().optional(),
    tone: z.enum(["formal", "casual", "technical", "creative"]).optional(),
    word_count: z.number().int().min(1).max(50000).optional(),
  }),

  DATA_ANALYSIS_REQUEST: z.object({
    data_url: z.string().url(),
    analysis_type: z.enum(["exploratory", "statistical", "visualization", "prediction"]).optional(),
    schema_description: z.string().max(2000).optional(),
    specific_questions: z.array(z.string()).optional(),
  }),

  CODE_REVIEW_REQUEST: z.object({
    repo_url: z.string().url(),
    commit: z.string().min(7).max(64),
    files: z.array(z.string()).optional(),
    context: z.string().max(1000).optional(),
    focus_areas: z.array(z.enum(["security", "correctness", "performance", "style"])).optional(),
  }),

  CONTRACT_REVIEW_REQUEST: z.object({
    document_url: z.string().url(),
    jurisdiction: z.string().optional(),
    focus_clauses: z.array(z.string()).optional(),
    urgency: z.enum(["low", "normal", "high", "critical"]).optional(),
  }),

  SECURITY_AUDIT_REQUEST: z.object({
    target: z.string(),
    target_type: z.enum(["repository", "url", "infrastructure"]).optional(),
    scope: z.string().max(2000).optional(),
    constraints: z.string().max(1000).optional(),
  }),

  AGENT_INTRODUCTION: z.object({
    capabilities: z.array(z.string()),
    availability: z.enum(["always", "business_hours", "on_demand"]).optional(),
    pricing: z.string().optional(),
    supported_task_types: z.array(z.string()).optional(),
    bbs_post_url: z.string().url().optional(),
  }),

  SYSTEM_NOTIFICATION: z.object({
    type: z.enum([
      "TIER_LIMIT_WARNING", "CREDIT_DEPLETED", "KEY_EXPIRING",
      "RATE_LIMITED", "WELCOME", "ANNOUNCEMENT",
    ]),
    message: z.string(),
    action_label: z.string().optional(),
    action_url: z.string().url().optional(),
  }),

  TASK_DELEGATION: z.object({
    instruction: z.string().max(4000),
    output_format: z.string(),
    deadline_unix_ms: z.number().int().optional(),
    dependencies: z.array(z.string()).optional(),
    max_budget_credits: z.number().int().optional(),
  }),
} as const;

export type TaskType = keyof typeof TaskSchemas;

// ── API Request / Response Types ──
export interface SendMessageParams {
  recipient: string;
  taskType: TaskType;
  subject?: string;
  bodyMd?: string;
  payload: Record<string, unknown>;
  priority?: "low" | "normal" | "urgent";
  ttlSeconds?: number;
  threadId?: string;
  inReplyTo?: string;
  metadata?: Record<string, unknown>;
}

export interface MessageResponse {
  messageId: string;
  threadId: string | null;
  inReplyTo: string | null;
  subject: string;
  sender: string;
  recipient: string;
  taskType: string;
  priority: string;
  payload: Record<string, unknown>;
  bodyMd?: string;
  metadata: Record<string, unknown> | null;
  status: string;
  isRead: boolean;
  securityFlags: string[];
  signature: string | null;
  ttlSeconds: number;
  expiresAt: string;
  createdAt: string;
}

export interface InboxParams {
  page?: number;
  pageSize?: number;
  status?: "unread" | "read" | "all";
  taskType?: string;
}

export interface PaginatedResponse<T> {
  messages: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface DirectoryEntry {
  address: string;
  keyName: string;
  identityAlias: string;
  trustScore: number;
  reviewCount: number;
  hasSignature: boolean;
}

export interface DirectoryResponse {
  entries: DirectoryEntry[];
  total: number;
  page: number;
  pageSize: number;
}

export interface TaskTypeInfo {
  type_name: string;
  category: string;
  description: string;
  schema: Record<string, unknown>;
}

export interface ErrorResponse {
  error_code: string;
  message: string;
  detail?: string;
}
