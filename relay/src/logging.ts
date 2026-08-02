// Structured JSON logging for events an operator (or a future small
// metrics pipeline) would want to query later — OAuth outcomes,
// producer/viewer connect/disconnect, validation failures, rejected
// payloads. Deliberately NOT a general-purpose logger: logEvent() only
// accepts fields from an explicit allowlist, so a call site can never
// accidentally leak a credential, token, JWT, secret, or full payload into
// the logs by passing an unexpected field — that's a structural guarantee
// (the field is dropped), not just a convention every call site has to
// remember to follow.

export type LogFieldValue = string | number | boolean;

export interface LogFields {
  [key: string]: LogFieldValue | undefined;
}

/**
 * Every field name any call site is allowed to log, across all events.
 * Deliberately an allowlist of coarse, non-identifying facts (ids, counts,
 * byte sizes, channel/session ids, generic reasons) — never raw
 * tokens/credentials/JWTs/the Extension shared secret/hidden-card
 * identity/full card payloads. Extend this only with fields that are safe
 * by construction, never to unblock one specific call site that wants to
 * log something more sensitive.
 */
const ALLOWED_LOG_FIELDS = new Set([
  "event",
  "channelId",
  "sessionId",
  "broadcasterId",
  "twitchUserId",
  "twitchLogin",
  "linkId",
  "reason",
  "count",
  "bytes",
  "cards",
  "sequence",
  "viewers",
  "durationMs",
  "remoteAddress",
  "path",
  "method",
  "status",
  "closeCode",
]);

const warnedUnknownFields = new Set<string>();

/** Emits one structured JSON line: {ts, event, ...fields}. Any field not on ALLOWED_LOG_FIELDS is dropped — not silently: the first time an unrecognized field name is seen, a warning names it, so a genuinely-needed new field gets noticed and deliberately added rather than just vanishing from the logs forever. */
export function logEvent(event: string, fields: LogFields = {}): void {
  const safeFields: Record<string, LogFieldValue> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (!ALLOWED_LOG_FIELDS.has(key)) {
      if (!warnedUnknownFields.has(key)) {
        warnedUnknownFields.add(key);
        console.warn(`[logging] dropped unrecognized log field "${key}" — add it to ALLOWED_LOG_FIELDS in logging.ts if it's safe to log`);
      }
      continue;
    }
    safeFields[key] = value;
  }
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...safeFields }));
}
