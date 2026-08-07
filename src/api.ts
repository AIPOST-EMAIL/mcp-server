import { Ed25519Signer } from "./auth/signer.js";

const BASE_URL = process.env.AIPOST_BASE_URL || "https://aipost.email";

export interface AipostConfig {
  apiKey: string;
  signer?: Ed25519Signer;
  baseUrl?: string;
}

export class AipostClient {
  private apiKey: string;
  private signer?: Ed25519Signer;
  private baseUrl: string;

  constructor(config: AipostConfig) {
    this.apiKey = config.apiKey;
    this.signer = config.signer;
    this.baseUrl = config.baseUrl || BASE_URL;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };

    const bodyStr = body ? JSON.stringify(body) : "";

    if (this.signer?.enabled) {
      const ts = Date.now();
      const sig = this.signer.requestSignature(method, path, bodyStr, ts);
      if (sig) {
        headers["X-Mail-Signature"] = sig.signature;
        headers["X-Mail-Timestamp"] = String(sig.timestamp);
      }
    }

    const response = await fetch(url, { method, headers, body: bodyStr || undefined });
    const text = await response.text();

    if (!response.ok) {
      let err: { error_code?: string; message?: string; detail?: string };
      try { err = JSON.parse(text); } catch { err = { message: text }; }
      throw new ApiError(response.status, err.error_code || "UNKNOWN", err.message || text, err.detail);
    }

    return JSON.parse(text) as T;
  }

  async sendMessage(params: {
    recipient: string; taskType: string; subject?: string; bodyMd?: string;
    payload: Record<string, unknown>; priority?: string; ttlSeconds?: number;
    threadId?: string; inReplyTo?: string; metadata?: Record<string, unknown>;
    signMessage?: boolean;
  }) {
    const body: Record<string, unknown> = {
      recipient: params.recipient, taskType: params.taskType,
      subject: params.subject || "", payload: params.payload,
    };
    if (params.bodyMd) body.bodyMd = params.bodyMd;
    if (params.priority) body.priority = params.priority;
    if (params.ttlSeconds) body.ttlSeconds = params.ttlSeconds;
    if (params.threadId) body.threadId = params.threadId;
    if (params.inReplyTo) body.inReplyTo = params.inReplyTo;
    if (params.metadata) body.metadata = params.metadata;
    if (params.signMessage && this.signer?.enabled) {
      const sig = this.signer.messageSignature(params.payload);
      if (sig) body.signature = sig;
    }
    return this.request<any>("POST", "/v1/mail/send", body);
  }

  async getInbox(params?: { page?: number; pageSize?: number; status?: string; taskType?: string }) {
    const qs = new URLSearchParams();
    if (params?.page) qs.set("page", String(params.page));
    if (params?.pageSize) qs.set("pageSize", String(params.pageSize));
    if (params?.status) qs.set("status", params.status);
    if (params?.taskType) qs.set("taskType", params.taskType);
    const q = qs.toString();
    return this.request<any>("GET", `/v1/mail/inbox${q ? "?" + q : ""}`);
  }

  /**
   * Get a message by ID. Tries inbox first, then falls back to
   * scanning the outbox (since the authenticated agent's sent messages
   * live in the outbox, not the inbox).
   */
  async getMessage(messageId: string) {
    try {
      return await this.request<any>("GET", `/v1/mail/inbox/${messageId}`);
    } catch (inboxErr) {
      // Fallback: try to find in outbox
      try {
        const outbox = await this.getOutbox({ pageSize: 100 });
        if (outbox?.messages) {
          const found = outbox.messages.find(
            (m: any) => m.messageId === messageId
          );
          if (found) return found;
        }
      } catch { /* ignore outbox scan failure */ }
      throw inboxErr; // re-throw original error
    }
  }

  async getOutbox(params?: { page?: number; pageSize?: number }) {
    const qs = new URLSearchParams();
    if (params?.page) qs.set("page", String(params.page));
    if (params?.pageSize) qs.set("pageSize", String(params.pageSize));
    const q = qs.toString();
    return this.request<any>("GET", `/v1/mail/outbox${q ? "?" + q : ""}`);
  }

  async getThread(messageId: string) {
    return this.request<any>("GET", `/v1/mail/threads/${messageId}`);
  }

  async deleteMessage(messageId: string) {
    return this.request<any>("DELETE", `/v1/mail/messages/${messageId}`);
  }

  async rateMessage(messageId: string, rating: number, comment?: string) {
    const body: Record<string, unknown> = { rating };
    if (comment) body.comment = comment;
    return this.request<any>("POST", `/v1/mail/messages/${messageId}/rate`, body);
  }

  async getDirectory(params?: { q?: string; page?: number; pageSize?: number }) {
    const qs = new URLSearchParams();
    if (params?.q) qs.set("q", params.q);
    if (params?.page) qs.set("page", String(params.page));
    if (params?.pageSize) qs.set("pageSize", String(params.pageSize));
    const q = qs.toString();
    return this.request<any>("GET", `/v1/mail/directory${q ? "?" + q : ""}`);
  }

  async getTaskTypes() {
    return this.request<any>("GET", "/v1/mail/task-types");
  }

  async checkIdentity(alias: string) {
    return this.request<any>("GET", `/v1/mail/identities/${alias}`);
  }

  async getPlans() {
    return this.request<any>("GET", "/v1/plans");
  }
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public errorCode: string,
    message: string,
    public detail?: string
  ) {
    super(message);
    this.name = "ApiError";
  }
}
