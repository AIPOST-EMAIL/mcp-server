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

export interface MailEvent {
  /** Unique event ID (assigned locally) */
  eventId: string;
  /** SSE event type (e.g., "message.new", "message.updated", "ping") */
  eventType: string;
  /** Parsed event data */
  data: unknown;
  /** Unix timestamp when the event was received */
  receivedAt: number;
}

export class EventStream {
  private events: MailEvent[] = [];
  private running = false;
  private _connected = false;
  private reconnectDelay = 1000;
  private maxReconnectDelay = 30_000;
  private maxBufferSize = 1000;
  private apiKey: string;
  private baseUrl: string;
  private abortController: AbortController | null = null;
  private eventCounter = 0;
  /** Timestamp of last successful SSE connection */
  private lastConnectedAt = 0;
  /** Timestamp of last event received */
  private lastEventAt = 0;

  constructor(config: { apiKey: string; baseUrl?: string }) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl || "https://aipost.email";
  }

  /** Start the background SSE connection. Idempotent — safe to call multiple times. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.abortController = new AbortController();
    console.error("[aipost-mcp] SSE event stream starting...");
    this.connect();
  }

  /** Stop the background SSE connection. */
  stop(): void {
    this.running = false;
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    console.error("[aipost-mcp] SSE event stream stopped");
  }

  /** Get buffered events and optionally clear the buffer. */
  getEvents(options?: { clear?: boolean }): MailEvent[] {
    const snapshot = [...this.events];
    if (options?.clear) {
      this.events = [];
    }
    return snapshot;
  }

  /** Return the number of buffered events. */
  get bufferSize(): number {
    return this.events.length;
  }

  /** Whether the SSE stream is currently connected. */
  get connected(): boolean {
    return this._connected;
  }

  /** Milliseconds since last event was received (0 if never). */
  get lastEventAge(): number {
    return this.lastEventAt ? Date.now() - this.lastEventAt : 0;
  }

  /** Milliseconds since last successful connection. */
  get lastConnectedAge(): number {
    return this.lastConnectedAt ? Date.now() - this.lastConnectedAt : 0;
  }

  private async connect(): Promise<void> {
    while (this.running) {
      try {
        console.error("[aipost-mcp] SSE connecting...");
        const response = await fetch(`${this.baseUrl}/v1/mail/events`, {
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            Accept: "text/event-stream",
          },
          signal: this.abortController?.signal,
        });

        if (!response.ok) {
          const text = await response.text().catch(() => "");
          console.error(`[aipost-mcp] SSE connection failed: ${response.status} ${text}`);
          await this.backoff();
          continue;
        }

        if (!response.body) {
          console.error("[aipost-mcp] SSE response has no body");
          await this.backoff();
          continue;
        }

        console.error("[aipost-mcp] SSE connected, reading stream...");
        this._connected = true;
        this.lastConnectedAt = Date.now();
        this.reconnectDelay = 1000; // reset on successful connection

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        // SSE field buffers — dispatched on empty line per spec
        let eventType = "";
        let dataBuffer: string[] = [];
        let heartbeatCount = 0;

        while (this.running) {
          const { done, value } = await reader.read();
          if (done) {
            this._connected = false;
            console.error("[aipost-mcp] SSE stream ended, reconnecting...");
            break;
          }

          buffer += decoder.decode(value, { stream: true });
          // SSE spec: lines end with \r\n, \n, or \r
          const lines = buffer.split(/\r?\n/);
          // Keep the last partial line in buffer
          buffer = lines.pop() || "";

          for (const line of lines) {
            // Strip trailing \r (explicit, even though split handles most cases)
            const clean = line.endsWith("\r") ? line.slice(0, -1) : line;

            if (clean === "") {
              // Empty line = dispatch event (SSE spec §9.2.6)
              if (dataBuffer.length > 0) {
                const data = dataBuffer.join("\n");
                this.handleEvent(eventType || "message", data);
              }
              // Reset field buffers for next event
              eventType = "";
              dataBuffer = [];
            } else if (clean.startsWith(":")) {
              // Comment line — heartbeat
              if (clean === ": ping") {
                heartbeatCount++;
                if (heartbeatCount % 10 === 0) {
                  console.error(`[aipost-mcp] SSE alive (${heartbeatCount} heartbeats, ${this.events.length} events buffered)`);
                }
              }
            } else if (clean.startsWith("event:")) {
              eventType = clean.slice(6).trim();
            } else if (clean.startsWith("data:")) {
              // SSE spec §9.2.4: append value to data buffer + LF
              dataBuffer.push(clean.slice(5).trimStart());
            }
            // Other fields (id:, retry:) — ignored for now
          }
        }
      } catch (err: unknown) {
        this._connected = false;
        if (err instanceof DOMException && err.name === "AbortError") {
          console.error("[aipost-mcp] SSE aborted");
          return;
        }
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[aipost-mcp] SSE error: ${msg}`);
      }

      await this.backoff();
    }
  }

  private async backoff(): Promise<void> {
    if (!this.running) return;
    console.error(`[aipost-mcp] SSE reconnecting in ${this.reconnectDelay}ms...`);
    await sleep(this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
  }

  private handleEvent(eventType: string, rawData: string): void {
    let data: unknown = rawData;
    try {
      data = JSON.parse(rawData);
    } catch {
      // keep as raw string if not JSON
    }

    const event: MailEvent = {
      eventId: `evt_${++this.eventCounter}_${Date.now()}`,
      eventType,
      data,
      receivedAt: Date.now(),
    };

    this.lastEventAt = Date.now();
    console.error(`[aipost-mcp] SSE event: ${eventType} (buffer: ${this.events.length + 1})`);

    // Enforce buffer size limit (FIFO)
    while (this.events.length >= this.maxBufferSize) {
      this.events.shift();
    }

    this.events.push(event);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
