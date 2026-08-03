// Short-lived handoff from a completed OAuth callback (which runs in a
// plain browser tab) back to the extension's background worker, which
// can't receive the callback directly. The extension generates a linkId
// before starting the flow, passes it through so the callback can find it
// again (see http/routes/auth-twitch.ts wiring), then polls this store
// until a credential is ready and fetches it exactly once. In-memory only
// — same reasoning as state-store.ts, and a raw producer credential must
// never touch persistent storage in plaintext regardless.

export type LinkStatus = "pending" | "ready" | "not-found";

export interface ReadyLinkResult {
  credential: string;
  /** The linked broadcaster's Twitch login — carried alongside the credential so the extension's status UI can show "Connected as X" without a second round trip. */
  displayName: string;
}

export interface LinkHandoffStore {
  markPending(linkId: string): void;
  markReady(linkId: string, result: ReadyLinkResult): void;
  status(linkId: string): LinkStatus;
  /** Single-use: returns the result once, then clears the entry so it can never be fetched a second time. */
  redeem(linkId: string): ReadyLinkResult | undefined;
}

const DEFAULT_TTL_MS = 10 * 60 * 1000;

interface Entry {
  result: ReadyLinkResult | undefined; // undefined while pending
  createdAt: number;
}

export function createLinkHandoffStore(options: { ttlMs?: number; now?: () => number } = {}): LinkHandoffStore {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now ?? (() => Date.now());

  const entries = new Map<string, Entry>();

  function isExpired(entry: Entry): boolean {
    return now() - entry.createdAt > ttlMs;
  }

  return {
    markPending(linkId: string): void {
      entries.set(linkId, { result: undefined, createdAt: now() });
    },
    markReady(linkId: string, result: ReadyLinkResult): void {
      // Keep the original createdAt if this linkId was already marked
      // pending (normal case) — a marker created fresh here just means no
      // one called markPending first, which is fine too.
      const existing = entries.get(linkId);
      entries.set(linkId, { result, createdAt: existing?.createdAt ?? now() });
    },
    status(linkId: string): LinkStatus {
      const entry = entries.get(linkId);
      if (!entry || isExpired(entry)) return "not-found";
      return entry.result === undefined ? "pending" : "ready";
    },
    redeem(linkId: string): ReadyLinkResult | undefined {
      const entry = entries.get(linkId);
      if (!entry || isExpired(entry) || entry.result === undefined) return undefined;
      entries.delete(linkId); // single-use regardless of outcome
      return entry.result;
    },
  };
}
