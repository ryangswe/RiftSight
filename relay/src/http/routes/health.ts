// GET /health — process is up. GET /ready — process is up AND its
// dependencies (currently: the database) are actually reachable. Kept
// distinct because a process can be alive but not yet able to serve
// traffic correctly (e.g. the DB file/volume isn't mounted yet) — a
// deployment platform's health check and readiness/traffic-admission check
// usually want to ask two different questions.

import type { DbClient } from "../../db/client.js";
import { jsonResponse, type HttpResponse } from "../types.js";

export function handleHealth(): HttpResponse {
  return jsonResponse(200, { status: "ok" });
}

export interface ReadyDeps {
  db: DbClient;
}

export async function handleReady(deps: ReadyDeps): Promise<HttpResponse> {
  try {
    await deps.db.execute("SELECT 1");
    return jsonResponse(200, { status: "ready" });
  } catch (err) {
    return jsonResponse(503, { status: "not-ready", error: err instanceof Error ? err.message : "unknown error" });
  }
}
