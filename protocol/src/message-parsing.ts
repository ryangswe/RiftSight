import { ServerMessageSchema, ViewerCountMessageSchema, ViewerServerMessageSchema } from "./schema.js";
import type { OverlayState, SubscribeRejectedReason } from "./types.js";

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

/**
 * A parsed relay->viewer message for NEW (non-Twitch) viewer hosts, as a
 * tagged event: state updates, explicit subscribe rejections, and
 * keepalive pings. The legacy parseServerMessage above is deliberately
 * untouched — the Twitch viewer never receives the new shapes, and its
 * parser staying byte-identical is part of this milestone shipping zero
 * Twitch-frontend changes.
 */
export type ViewerServerEvent =
  | { kind: "state"; state: OverlayState }
  | { kind: "rejected"; reason: SubscribeRejectedReason }
  | { kind: "ping" };

/**
 * Fail-closed tagged-union counterpart to parseServerMessage for hosts
 * that speak the full viewer vocabulary (YouTube content script's
 * background socket). Same contract: undefined for non-JSON or
 * schema-invalid input, concise console warning, never the raw payload.
 */
export function parseViewerServerMessage(raw: string): ViewerServerEvent | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn("[protocol] dropped a non-JSON viewer message");
    return undefined;
  }

  const result = ViewerServerMessageSchema.safeParse(parsed);
  if (!result.success) {
    console.warn("[protocol] rejected an invalid viewer message", result.error.issues);
    return undefined;
  }

  const message = result.data;
  switch (message.type) {
    case "overlay-state":
      return { kind: "state", state: message.payload };
    case "subscribe-rejected":
      return { kind: "rejected", reason: message.reason };
    case "ping":
      return { kind: "ping" };
  }
}

/**
 * Producer-side counterpart to parseServerMessage — the only message shape
 * the relay currently ever sends back to a producer socket. Same
 * fail-closed contract: undefined for anything that isn't valid JSON or
 * doesn't match the schema, with a concise (never raw-payload) console
 * warning.
 */
export function parseViewerCountMessage(raw: string): number | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn("[protocol] dropped a non-JSON producer-bound message");
    return undefined;
  }

  const result = ViewerCountMessageSchema.safeParse(parsed);
  if (!result.success) {
    console.warn("[protocol] rejected an invalid producer-bound message", result.error.issues);
    return undefined;
  }

  return result.data.count;
}
