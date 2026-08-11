/**
 * Sender address filter for AIPost MCP Server.
 *
 * Supports two env vars (set in MCP client config, e.g. claude_desktop_config.json):
 *   AIPOST_SENDER_WHITELIST  – comma-separated; if set, ONLY these senders pass
 *   AIPOST_SENDER_BLACKLIST  – comma-separated; if set, these senders are blocked
 *
 * Whitelist takes precedence: when whitelist is set, blacklist is ignored.
 *
 * Every blacklist / whitelist entry and every sender address normalises to
 * { keyname, alias }.  Four input formats are accepted:
 *   1. alias.aipost.email            (short dot)
 *   2. keyname.alias.aipost.email    (full dot)
 *   3. alias@aipost.email            (short at)
 *   4. keyname.alias@aipost.email    (full at)
 *
 * Matching rules:
 *   - alias must always match (case-insensitive).
 *   - If the filter entry specifies a keyname, the sender's keyname must also
 *     match.  If the filter entry omits keyname, any keyname is accepted.
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
 * Parse an AIPost email address in any of the 4 supported formats.
 * Returns null when the address doesn't look like an AIPost address.
 */
export function parseAddress(raw: string): ParsedAddress | null {
  const s = raw.trim().toLowerCase();
  if (!s) return null;

  // At-format: alias@aipost.email  or  keyname.alias@aipost.email
  const atIdx = s.indexOf("@");
  if (atIdx !== -1) {
    const local = s.slice(0, atIdx);
    const domain = s.slice(atIdx + 1);
    if (domain !== "aipost.email") return null;
    return parseLocal(local);
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
   * Filter an array of objects that have a `sender` field.
   * Returns a new array with blocked senders removed.
   */
  filterBySender<T extends { sender?: string }>(items: T[]): T[] {
    if (!this.active) return items;
    return items.filter((item) => {
      if (!item.sender) return true; // no sender field — allow through
      return this.isAllowed(item.sender);
    });
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
   * Filter SSE events. Each event's `data` may contain a `sender` field.
   */
  filterEvents<T extends { data?: unknown }>(events: T[]): T[] {
    if (!this.active) return events;
    return events.filter((event) => {
      if (!event.data || typeof event.data !== "object") return true;
      const sender = (event.data as Record<string, unknown>).sender;
      if (typeof sender !== "string") return true;
      return this.isAllowed(sender);
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
  // alias must always match (case-insensitive — already lowercased)
  if (entry.alias !== sender.alias) return false;

  // If entry specifies a keyname, it must match
  if (entry.keyname !== null) {
    return entry.keyname === sender.keyname;
  }

  // Entry only specifies alias — any keyname is accepted
  return true;
}
