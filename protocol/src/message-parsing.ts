import { ServerMessageSchema } from "./schema.js";
import type { OverlayState } from "./types.js";

/**
 * Pure message-parsing boundary for anything subscribing to the relay (or
 * an equivalent backend) — a viewer's own defense in depth, after the
 * detector's visibility classification, the extension's toOverlayCard()
 * serializer, and the relay's own schema check. Returns undefined for
 * anything that fails to parse as JSON or fails ServerMessageSchema
 * validation, logging a concise reason (zod's `.issues`, never the raw
 * payload) so a rejected message is visible in the console without risking
 * a sensitive or oversized dump.
 */
export function parseServerMessage(raw: string): OverlayState | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn("[protocol] dropped a non-JSON message");
    return undefined;
  }

  const result = ServerMessageSchema.safeParse(parsed);
  if (!result.success) {
    console.warn("[protocol] rejected an invalid message", result.error.issues);
    return undefined;
  }

  return result.data.payload;
}
