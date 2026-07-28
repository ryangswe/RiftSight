// Shared constants so the extension's background worker and the debug
// viewer agree on where the local relay lives without duplicating literals.

export const RELAY_URL = "ws://localhost:8787";
export const DEFAULT_SESSION_ID = "local-debug";
