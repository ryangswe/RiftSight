// The streamer's persisted desire to be publishing — deliberately separate
// from publisher.ts's isPublishing() (the actual current state, which
// content/publishing-lifecycle.ts derives from this plus board presence).
// Mirrors auth.ts's exact existing chrome.storage.local pattern
// (STORAGE_KEY_LINK_STATE / getLinkState() / loadPersistedLinkState()) —
// an in-memory cache for synchronous reads within one worker lifetime,
// backed by chrome.storage.local so it survives everything a background
// service worker itself doesn't: suspension, the content script's own tab
// reloading or closing/reopening, and a full browser restart.

const STORAGE_KEY_PUBLISHING_INTENT = "riftsight.publishingIntent";

let currentIntent = false;

export function getPublishingIntent(): boolean {
  return currentIntent;
}

/** Call once at background worker startup (alongside loadPersistedLinkState) to restore intent across service-worker suspend/wake cycles and browser restarts. */
export async function loadPersistedPublishingIntent(): Promise<void> {
  const stored = (await chrome.storage.local.get(STORAGE_KEY_PUBLISHING_INTENT)) as Record<string, unknown>;
  currentIntent = Boolean(stored[STORAGE_KEY_PUBLISHING_INTENT]);
}

export async function setPublishingIntent(intent: boolean): Promise<void> {
  currentIntent = intent;
  await chrome.storage.local.set({ [STORAGE_KEY_PUBLISHING_INTENT]: intent });
}
