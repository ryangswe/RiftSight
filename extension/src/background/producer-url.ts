// Decides which WebSocket URL the producer connection (background.ts's
// connect()) should use. Pure — the actual globals/storage read are done
// once at the call site, mirroring twitch-extension's resolveRelayUrl.
//
// A stored producer credential means "Connect Twitch" (background/auth.ts)
// has already run — in that case, connect to the backend's authenticated
// /ws/producer endpoint (see relay/src/ws/producer-auth.ts) rather than the
// legacy RELAY_URL constant. No credential means development/twitch-local-
// test's zero-config path: unchanged, always RELAY_URL.

export interface ResolveProducerWsUrlOptions {
  /** __RIFTSIGHT_BACKEND_URL__ — an http(s) origin, not already a ws(s) URL. */
  backendUrl: string;
  credential: string | undefined;
  /** RELAY_URL from @riftsight/protocol — used verbatim when there's no stored credential. */
  fallbackRelayUrl: string;
}

export function resolveProducerWsUrl(options: ResolveProducerWsUrlOptions): string {
  if (!options.credential) {
    return options.fallbackRelayUrl;
  }

  if (!options.backendUrl) {
    throw new Error(
      "A producer credential is stored but RIFTSIGHT_BACKEND_URL is not configured — rebuild with RIFTSIGHT_BACKEND_URL set to your backend's origin."
    );
  }

  let backendOrigin: URL;
  try {
    backendOrigin = new URL(options.backendUrl);
  } catch {
    throw new Error(`RIFTSIGHT_BACKEND_URL is not a valid URL: "${options.backendUrl}"`);
  }

  const wsProtocol = backendOrigin.protocol === "https:" ? "wss:" : "ws:";
  const producerUrl = new URL("/ws/producer", `${wsProtocol}//${backendOrigin.host}`);
  producerUrl.searchParams.set("credential", options.credential);
  return producerUrl.toString();
}
