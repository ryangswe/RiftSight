// Adapts real Node HTTP objects to/from the plain HttpRequest/HttpResponse
// shapes every route handler is already written and tested against (see
// types.ts's header comment) — this is the only file in http/ that touches
// node:http directly. Deliberately a hand-rolled ~10-route dispatcher, not
// Express/Fastify/etc., matching this repo's consistent zero-framework
// style; the route surface is small enough that a framework would add
// dependency weight without removing any real complexity.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { DbClient } from "../db/client.js";
import type { StateStore } from "../auth/state-store.js";
import type { LinkHandoffStore } from "../auth/link-handoff.js";
import type { TwitchOAuthConfig } from "../auth/twitch-oauth.js";
import { handleAuthCallback, handleAuthStart } from "./routes/auth-twitch.js";
import { handleLinkStatus, handleProducerCredentialStatus, handleRotateProducerCredential } from "./routes/producer-credential.js";
import { handleHealth, handleReady } from "./routes/health.js";
import { jsonResponse, type HttpRequest, type HttpResponse } from "./types.js";
import { logEvent } from "../logging.js";
import { createRateLimiter, CREDENTIAL_ROTATE_LIMIT, OAUTH_START_LIMIT, PRODUCER_STATUS_LIMIT } from "../rate-limit.js";

export interface HttpRouterDeps {
  db: DbClient;
  stateStore: StateStore;
  linkHandoff: LinkHandoffStore;
  /**
   * undefined when TWITCH_API_CLIENT_ID/SECRET/TWITCH_OAUTH_REDIRECT_URI
   * aren't all configured (e.g. development mode with account linking not
   * set up yet). The OAuth routes still exist in that case — they respond
   * 503, not 404 — so "not configured" is distinguishable from "no such
   * route" while debugging.
   */
  oauthConfig: TwitchOAuthConfig | undefined;
}

function toHttpRequest(req: IncomingMessage): HttpRequest {
  const headers: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    headers[key] = Array.isArray(value) ? value[0] : value;
  }
  return { method: req.method ?? "GET", url: req.url ?? "/", headers };
}

function sendHttpResponse(res: ServerResponse, response: HttpResponse): void {
  res.writeHead(response.status, response.headers ?? {});
  res.end(response.body);
}

const OAUTH_NOT_CONFIGURED = jsonResponse(503, { error: "Twitch OAuth account linking is not configured on this backend" });
const RATE_LIMITED = jsonResponse(429, { error: "too many requests — please wait and try again" });

/**
 * Builds the plain HTTP request handler for the relay's unified server —
 * routing/dispatch only, each branch a thin call into an already-tested
 * pure/async handler. WebSocket upgrade requests never reach this: they're
 * intercepted by ws's own "upgrade" listener before Node emits a "request"
 * event for them (see server.ts).
 *
 * No explicit CORS headers are set anywhere here, deliberately — that's a
 * default-deny posture ("CORS restricted to known origins" from an empty
 * allowlist), not an oversight. The one legitimate cross-origin caller
 * (the extension's background service worker) isn't subject to the
 * browser's CORS check in the first place: MV3 extensions with a
 * host_permissions entry for this origin bypass CORS for fetches to it.
 * An arbitrary webpage's fetch() to these endpoints gets no
 * Access-Control-Allow-Origin header and is blocked by the browser's
 * default same-origin policy — exactly the restriction wanted, achieved by
 * omission rather than an allowlist that would need maintaining.
 *
 * Rate limiters are created once per createHttpRouter() call (once per
 * real server process in index.ts), not at module scope — sharing them
 * across every call site would leak state between independent router
 * instances, notably between test cases in this workspace's test suite.
 */
export function createHttpRouter(deps: HttpRouterDeps): (req: IncomingMessage, res: ServerResponse) => void {
  const oauthStartLimiter = createRateLimiter(OAUTH_START_LIMIT);
  const credentialRotateLimiter = createRateLimiter(CREDENTIAL_ROTATE_LIMIT);
  const producerStatusLimiter = createRateLimiter(PRODUCER_STATUS_LIMIT);

  return (req, res) => {
    const httpRequest = toHttpRequest(req);
    const pathname = new URL(httpRequest.url, "http://placeholder").pathname;
    const remoteAddress = req.socket.remoteAddress ?? "unknown";

    if (httpRequest.method === "GET" && pathname === "/health") {
      sendHttpResponse(res, handleHealth());
      return;
    }

    if (httpRequest.method === "GET" && pathname === "/ready") {
      void handleReady({ db: deps.db }).then((response) => sendHttpResponse(res, response));
      return;
    }

    if (httpRequest.method === "GET" && pathname === "/auth/twitch/start") {
      if (!oauthStartLimiter.tryConsume(remoteAddress)) {
        logEvent("oauth_link_rejected", { reason: "rate-limited", remoteAddress });
        sendHttpResponse(res, RATE_LIMITED);
        return;
      }
      if (!deps.oauthConfig) {
        sendHttpResponse(res, OAUTH_NOT_CONFIGURED);
        return;
      }
      sendHttpResponse(res, handleAuthStart(httpRequest, deps.oauthConfig, deps.stateStore, deps.linkHandoff));
      return;
    }

    if (httpRequest.method === "GET" && pathname === "/auth/twitch/callback") {
      if (!deps.oauthConfig) {
        sendHttpResponse(res, OAUTH_NOT_CONFIGURED);
        return;
      }
      void handleAuthCallback(httpRequest, {
        config: deps.oauthConfig,
        stateStore: deps.stateStore,
        linkHandoff: deps.linkHandoff,
        db: deps.db,
      }).then((response) => {
        logEvent(response.status === 200 ? "oauth_link_succeeded" : "oauth_link_failed", { status: response.status });
        sendHttpResponse(res, response);
      });
      return;
    }

    if (httpRequest.method === "GET" && pathname === "/api/link-status") {
      sendHttpResponse(res, handleLinkStatus(httpRequest, deps.linkHandoff));
      return;
    }

    if (httpRequest.method === "POST" && pathname === "/api/producer-credential/rotate") {
      if (!credentialRotateLimiter.tryConsume(remoteAddress)) {
        logEvent("credential_rotate_rejected", { reason: "rate-limited", remoteAddress });
        sendHttpResponse(res, RATE_LIMITED);
        return;
      }
      void handleRotateProducerCredential(httpRequest, deps.db).then((response) => {
        logEvent(response.status === 200 ? "credential_rotated" : "credential_rotate_failed", { status: response.status });
        sendHttpResponse(res, response);
      });
      return;
    }

    if (httpRequest.method === "GET" && pathname === "/api/producer-credential/status") {
      if (!producerStatusLimiter.tryConsume(remoteAddress)) {
        logEvent("producer_status_check", { reason: "rate-limited", remoteAddress });
        sendHttpResponse(res, RATE_LIMITED);
        return;
      }
      void handleProducerCredentialStatus(httpRequest, deps.db).then((response) => {
        const body = response.status === 200 ? (JSON.parse(response.body) as { status: string }).status : undefined;
        logEvent("producer_status_check", { reason: body ?? "missing-bearer-credential", status: response.status });
        sendHttpResponse(res, response);
      });
      return;
    }

    sendHttpResponse(res, jsonResponse(404, { error: "not found" }));
  };
}
