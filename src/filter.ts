/**
 * Sender address filter for AIPost MCP Server.
 *
 * Supports two env vars (set in MCP client config, e.g. claude_desktop_config.json):
 *   AIPOST_SENDER_WHITELIST  – comma-separated; if set, ONLY these senders pass
 *   AIPOST_SENDER_BLACKLIST  – comma-separated; if set, these senders are blocked
 *
 * Whitelist takes precedence: when whitelist is set, blacklist is ignored.
 *
 * Supported address formats:
 *
 *   AIPost addresses:
 *     1. alias.aipost.email            (short dot)
 *     2. keyname.alias.aipost.email    (full dot)
 *     3. alias@aipost.email            (short at)
 *     4. keyname.alias@aipost.email    (full at)
 *
 *   Standard email addresses (for external senders / domain filtering):
 *     5. user@domain.tld               (full email — exact match)
 *     6. @domain.tld                   (domain-only — matches any user@domain.tld)
 *
 * Matching rules:
 *   - For AIPost addresses: alias must always match (case-insensitive).
 *     If the filter entry specifies a keyname, the sender's keyname must also
 *     match. If the filter entry omits keyname, any keyname is accepted.
 *   - For standard emails: full case-insensitive exact match on the email.
 *   - For domain-only patterns (@domain.tld): matches any sender whose address
 *     ends with @domain.tld.
 *   - For EXTERNAL_EMAIL messages (IMAP imports): the filter checks both
 *     `sender` (display name) and `payload.from` (actual email address).
 */

const WHITELIST_ENV = "AIPOST_SENDER_WHITELIST";
const BLACKLIST_ENV = "AIPOST_SENDER_BLACKLIST";

// ── Address parsing ──────────────────────────────────────────────────────────

export interface ParsedAddress {
  /** Identity alias, e.g. "my-agent" — always present */
  alias: string;
  /** Keyname, e.g. "majin" — null when the address omits it */
  keyname: string | null;
}

/**
 * Parse an address in any supported format.
 *
 * AIPost formats:
 *   1. alias.aipost.email            (short dot)
 *   2. keyname.alias.aipost.email    (full dot)
 *   3. alias@aipost.email            (short at)
 *   4. keyname.alias@aipost.email    (full at)
 *
 * Standard email formats (for external senders / domain-level filtering):
 *   5. user@domain.tld               (full email)
 *   6. @domain.tld                   (domain-only — used in filter entries)
 *
 * Returns null when the address is unparseable (e.g. a bare display name).
 */
export function parseAddress(raw: string): ParsedAddress | null {
  const s = raw.trim().toLowerCase();
  if (!s) return null;

  // At-format
  const atIdx = s.indexOf("@");
  if (atIdx !== -1) {
    const local = s.slice(0, atIdx);
    const domain = s.slice(atIdx + 1);

    // AIPost address: alias@aipost.email or keyname.alias@aipost.email
    if (domain === "aipost.email") {
      return parseLocal(local);
    }

    // Standard email: user@domain.tld  or domain-only pattern: @domain.tld
    if (domain.includes(".")) {
      // local is empty for @domain.tld patterns; non-empty for user@domain.tld
      return { alias: s, keyname: null };
    }

    // Bare domain without TLD (e.g. "user@localhost") — not useful for filtering
    return null;
  }

  // Dot-format: alias.aipost.email  or  keyname.alias.aipost.email
  if (!s.endsWith(".aipost.email")) return null;
  const prefix = s.slice(0, -".aipost.email".length);
  if (!prefix) return null;
  return parseLocal(prefix);
}

/** Parse the "local" part (before @ or before .aipost.email). */
function parseLocal(local: string): ParsedAddress | null {
  const parts = local.split(".");
  if (parts.length === 1 && parts[0]) {
    return { alias: parts[0], keyname: null };
  }
  if (parts.length === 2 && parts[0] && parts[1]) {
    return { keyname: parts[0], alias: parts[1] };
  }
  return null; // more than 2 parts or empty segment
}

// ── Filter entry (pre-parsed) ────────────────────────────────────────────────

interface FilterEntry {
  alias: string;
  keyname: string | null; // null = match any keyname
}

function parseFilterEntry(raw: string): FilterEntry | null {
  const parsed = parseAddress(raw);
  if (!parsed) return null;
  return { alias: parsed.alias, keyname: parsed.keyname };
}

// ── SenderFilter ─────────────────────────────────────────────────────────────

export class SenderFilter {
  /** Whether any filtering is active */
  readonly active: boolean;
  /** Filter mode currently in effect */
  readonly mode: "whitelist" | "blacklist" | "none";
  /** Number of filter entries loaded */
  readonly entryCount: number;

  private entries: FilterEntry[];

  constructor(env: Record<string, string | undefined>) {
    const wlRaw = env[WHITELIST_ENV];
    const blRaw = env[BLACKLIST_ENV];

    if (wlRaw !== undefined && wlRaw.trim() !== "") {
      this.mode = "whitelist";
      this.entries = this.parseList(wlRaw);
      this.active = this.entries.length > 0;
      this.entryCount = this.entries.length;
      if (this.active) {
        console.error(`[aipost-mcp] Sender whitelist: ${this.entries.length} entries`);
      }
    } else if (blRaw !== undefined && blRaw.trim() !== "") {
      this.mode = "blacklist";
      this.entries = this.parseList(blRaw);
      this.active = this.entries.length > 0;
      this.entryCount = this.entries.length;
      if (this.active) {
        console.error(`[aipost-mcp] Sender blacklist: ${this.entries.length} entries`);
      }
    } else {
      this.mode = "none";
      this.active = false;
      this.entryCount = 0;
      this.entries = [];
      console.error("[aipost-mcp] Sender filter: disabled (no whitelist or blacklist set)");
    }
  }

  // ── Public API ───────────────────────────────────────────────────────────

  /** Check whether a sender address should be visible. */
  isAllowed(rawSender: string): boolean {
    if (!this.active) return true;

    const sender = parseAddress(rawSender);
    if (!sender) {
      // Can't parse the sender — conservative: block in whitelist mode, allow in blacklist mode
      return this.mode !== "whitelist";
    }

    const matched = this.entries.some((entry) => entryMatches(entry, sender));

    if (this.mode === "whitelist") return matched;
    // blacklist mode
    return !matched;
  }

  /**
   * Check whether a mail item is allowed, considering both `sender` and
   * `payload.from` (external emails store the real address in payload.from).
   */
  isItemAllowed(item: { sender?: string; payload?: { from?: string } }): boolean {
    if (!this.active) return true;

    // Check sender field first
    if (item.sender && this.isAllowed(item.sender)) return true;

    // Fallback: for EXTERNAL_EMAIL, the sender field may be a display name;
    // the actual email address is in payload.from.
    if (item.payload?.from && this.isAllowed(item.payload.from)) return true;

    // If we have any sender info but neither check passed, block
    if (item.sender || item.payload?.from) return false;

    // No sender info at all — allow through
    return true;
  }

  /**
   * Filter an array of objects that have a `sender` field (and optionally
   * `payload.from` for external emails).
   * Returns a new array with blocked senders removed.
   */
  filterBySender<T extends { sender?: string; payload?: { from?: string } }>(items: T[]): T[] {
    if (!this.active) return items;
    return items.filter((item) => this.isItemAllowed(item));
  }

  /**
   * Filter an array of objects that have a `recipient` field.
   * Used for outbox and for send_message pre-flight checks.
   */
  filterByRecipient<T extends { recipient?: string }>(items: T[]): T[] {
    if (!this.active) return items;
    return items.filter((item) => {
      if (!item.recipient) return true;
      return this.isAllowed(item.recipient);
    });
  }

  /**
   * Filter an array of objects that have an `address` field.
   * Used for directory entries.
   */
  filterByAddress<T extends { address?: string }>(items: T[]): T[] {
    if (!this.active) return items;
    return items.filter((item) => {
      if (!item.address) return true;
      return this.isAllowed(item.address);
    });
  }

  /**
   * Filter SSE events. Each event's `data` may contain a `sender` field
   * and/or `payload.from` (external emails).
   */
  filterEvents<T extends { data?: unknown }>(events: T[]): T[] {
    if (!this.active) return events;
    return events.filter((event) => {
      if (!event.data || typeof event.data !== "object") return true;
      const d = event.data as Record<string, unknown>;
      const sender = typeof d.sender === "string" ? d.sender : undefined;
      const payload =
        d.payload && typeof d.payload === "object"
          ? (d.payload as Record<string, unknown>)
          : undefined;
      const from = payload && typeof payload.from === "string" ? payload.from : undefined;

      return this.isItemAllowed({ sender, payload: from ? { from } : undefined });
    });
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private parseList(raw: string): FilterEntry[] {
    const entries: FilterEntry[] = [];
    const seen = new Set<string>();

    for (const part of raw.split(",")) {
      const trimmed = part.trim();
      if (!trimmed) continue;

      const entry = parseFilterEntry(trimmed);
      if (!entry) {
        console.error(`[aipost-mcp] WARNING: Cannot parse filter entry "${trimmed}" — skipping`);
        continue;
      }

      // Deduplicate
      const key = `${entry.keyname ?? "*"}.${entry.alias}`;
      if (seen.has(key)) continue;
      seen.add(key);

      entries.push(entry);
    }

    return entries;
  }
}

// ── Matching helpers ─────────────────────────────────────────────────────────

function entryMatches(entry: FilterEntry, sender: ParsedAddress): boolean {
  // ── Domain-only pattern: @domain.tld matches any user@domain.tld ──────
  if (entry.alias.startsWith("@")) {
    return sender.alias.endsWith(entry.alias);
  }

  // ── Standard email matching (both contain @, non-AIPost) ──────────────
  if (entry.alias.includes("@") && sender.alias.includes("@")) {
    return entry.alias === sender.alias;
  }

  // ── AIPost address matching ────────────────────────────────────────────
  // alias must always match (case-insensitive — already lowercased)
  if (entry.alias !== sender.alias) return false;

  // If entry specifies a keyname, it must match
  if (entry.keyname !== null) {
    return entry.keyname === sender.keyname;
  }

  // Entry only specifies alias — any keyname is accepted
  return true;
}
