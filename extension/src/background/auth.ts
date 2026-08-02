// Account-linking glue: owns chrome.storage.local persistence, linkId
// generation, opening the Twitch-linking tab, and polling the backend
// until a producer credential is ready. Deliberately thin — the actual
// state transitions live in the pure, unit-tested link-state.ts; this
// module's only job is translating real chrome/fetch events into the
// LinkEvents that reducer understands.
//
// The popup-closes-on-tab-navigation problem is why this runs in the
// background service worker rather than wherever the "Connect Twitch"
// button lives: clicking it navigates the user to Twitch's own consent
// screen in a new/active tab, which would tear down a popup immediately.
// The debug panel (content/inventory.ts) just triggers this and polls its
// *own* status back from here — it never owns the linking flow itself.

import { INITIAL_LINK_STATE, reduceLinkState, type LinkState } from "./link-state.js";

const STORAGE_KEY_CREDENTIAL = "riftsight.producerCredential";
const STORAGE_KEY_LINK_STATE = "riftsight.linkState";

const POLL_INTERVAL_MS = 2000;
// A streamer who never completes the Twitch consent screen shouldn't leave
// this polling forever — give up and fall back to "not-connected" so the
// UI doesn't hang on "waiting for authorization" indefinitely.
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

let currentState: LinkState = INITIAL_LINK_STATE;
let pollTimer: ReturnType<typeof setTimeout> | undefined;

function backendUrl(): string {
  return __RIFTSIGHT_BACKEND_URL__;
}

async function persistState(state: LinkState): Promise<void> {
  currentState = state;
  await chrome.storage.local.set({ [STORAGE_KEY_LINK_STATE]: state });
}

export function getLinkState(): LinkState {
  return currentState;
}

/** Call once at background worker startup to restore state across service-worker suspend/wake cycles. */
export async function loadPersistedLinkState(): Promise<void> {
  const stored = (await chrome.storage.local.get(STORAGE_KEY_LINK_STATE)) as Record<string, unknown>;
  const persisted = stored[STORAGE_KEY_LINK_STATE] as LinkState | undefined;
  if (persisted) currentState = persisted;
}

export async function getStoredCredential(): Promise<string | undefined> {
  const stored = (await chrome.storage.local.get(STORAGE_KEY_CREDENTIAL)) as Record<string, unknown>;
  return stored[STORAGE_KEY_CREDENTIAL] as string | undefined;
}

function stopPolling(): void {
  if (pollTimer !== undefined) {
    clearTimeout(pollTimer);
    pollTimer = undefined;
  }
}

async function pollOnce(linkId: string, deadline: number): Promise<void> {
  if (Date.now() > deadline) {
    stopPolling();
    await persistState(reduceLinkState(currentState, { type: "poll-not-found" }));
    return;
  }

  let data: { status: string; credential?: string; displayName?: string };
  try {
    const response = await fetch(`${backendUrl()}/api/link-status?linkId=${encodeURIComponent(linkId)}`);
    if (!response.ok) {
      await persistState(reduceLinkState(currentState, { type: "poll-error" }));
      pollTimer = setTimeout(() => void pollOnce(linkId, deadline), POLL_INTERVAL_MS);
      return;
    }
    data = (await response.json()) as typeof data;
  } catch {
    await persistState(reduceLinkState(currentState, { type: "poll-error" }));
    pollTimer = setTimeout(() => void pollOnce(linkId, deadline), POLL_INTERVAL_MS);
    return;
  }

  if (data.status === "ready" && data.credential && data.displayName) {
    stopPolling();
    await chrome.storage.local.set({ [STORAGE_KEY_CREDENTIAL]: data.credential });
    await persistState(reduceLinkState(currentState, { type: "poll-ready", displayName: data.displayName }));
    return;
  }

  if (data.status === "not-found") {
    stopPolling();
    await persistState(reduceLinkState(currentState, { type: "poll-not-found" }));
    return;
  }

  // Still pending — keep polling.
  await persistState(reduceLinkState(currentState, { type: "poll-pending" }));
  pollTimer = setTimeout(() => void pollOnce(linkId, deadline), POLL_INTERVAL_MS);
}

/** Starts a fresh linking attempt: opens the Twitch authorization tab and begins polling for the resulting credential. */
export async function startLink(): Promise<void> {
  stopPolling();
  await persistState(reduceLinkState(currentState, { type: "start-link" }));

  const linkId = crypto.randomUUID();
  await chrome.tabs.create({ url: `${backendUrl()}/auth/twitch/start?linkId=${encodeURIComponent(linkId)}` });

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  pollTimer = setTimeout(() => void pollOnce(linkId, deadline), POLL_INTERVAL_MS);
}

/** Forgets the stored credential and resets link state — does not revoke the credential server-side (that's the streamer's own /api/producer-credential/rotate or backend allowlist removal). */
export async function disconnect(): Promise<void> {
  stopPolling();
  await chrome.storage.local.remove(STORAGE_KEY_CREDENTIAL);
  await persistState(reduceLinkState(currentState, { type: "disconnect" }));
}

/** Called when the relay rejects our stored credential (revoked/no-longer-permitted) — see background.ts's connection handling, wired up in a later stage alongside the actual authenticated WS handshake. */
export async function reportCredentialRejected(): Promise<void> {
  await persistState(reduceLinkState(currentState, { type: "credential-rejected" }));
}
