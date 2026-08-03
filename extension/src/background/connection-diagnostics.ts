// Pure decision logic for background.ts's producer-connection-failure
// diagnosis (see auth.ts's checkProducerCredentialStatus for the actual
// network call) — split out so the actual rules ("when do we bother
// checking", "which results mean the credential itself is bad") are
// directly unit-testable, matching this repo's established "pure logic
// tested, chrome.*/WebSocket-touching glue thin" split (see link-state.ts
// for the same pattern applied to account linking).

import type { ProducerCredentialStatusResult } from "./auth.js";

/**
 * Checking after every single failed connection attempt would fire on
 * every ordinary network blip; checking only after a genuinely sustained
 * failure (2 consecutive attempts, not 1) tolerates a one-off transient
 * failure without ever calling the endpoint for it.
 */
export const STATUS_CHECK_ATTEMPT_THRESHOLD = 2;

/** True exactly once per failure streak — the moment it crosses the threshold, not on every attempt after. */
export function shouldCheckCredentialStatus(consecutiveFailedAttempts: number, alreadyCheckedThisStreak: boolean): boolean {
  return consecutiveFailedAttempts === STATUS_CHECK_ATTEMPT_THRESHOLD && !alreadyCheckedThisStreak;
}

/**
 * "valid" means the backend confirms the credential is fine — the
 * connection failures were something else (a network blip that happened
 * to repeat, a backend restart mid-reconnect, ...). "network-error" means
 * the check itself couldn't get a definitive answer. Neither is ever a
 * reason to make the streamer reconnect Twitch; every other outcome
 * genuinely means the stored credential itself won't work anymore.
 */
export function credentialNeedsReconnect(result: ProducerCredentialStatusResult): boolean {
  return result.status !== "valid" && result.status !== "network-error";
}
