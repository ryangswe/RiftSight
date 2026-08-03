// Minimal request/response shapes shared by every route handler — deliberately
// not Node's raw IncomingMessage/ServerResponse, so a handler can be called
// directly with a synthetic request in a unit test without a real socket.
// http/server.ts (added when the server is actually wired up to listen)
// adapts real Node HTTP objects to/from these.

export interface HttpRequest {
  method: string;
  /** Path + query string only, e.g. "/auth/twitch/callback?code=...&state=...". */
  url: string;
  headers: Record<string, string | undefined>;
}

export interface HttpResponse {
  status: number;
  headers?: Record<string, string>;
  body: string;
}

export function htmlResponse(status: number, body: string): HttpResponse {
  return { status, headers: { "Content-Type": "text/html; charset=utf-8" }, body };
}

export function jsonResponse(status: number, body: unknown): HttpResponse {
  return { status, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}
