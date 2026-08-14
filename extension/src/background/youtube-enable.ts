// The optional-permission + dynamic-registration lifecycle for the
// YouTube viewer content script. The permission is OPTIONAL
// (manifest.template.json's optional_host_permissions) precisely so
// adding YouTube support never triggers Chrome's "new permissions —
// extension disabled until re-approved" flow for the existing installed
// base; the price is that everything here is runtime bookkeeping instead
// of a static manifest entry.
//
// Shared by both extension contexts that touch the lifecycle: the POPUP
// calls chrome.permissions.request (it must — Chrome requires a user
// gesture in an extension page) and then enableYouTube(); the BACKGROUND
// calls syncYouTubeRegistration() on every worker boot and from the
// permission listeners, so registration state always reconverges with
// permission state no matter which side changed it (including the user
// revoking the permission from chrome://extensions).

export const YOUTUBE_ORIGIN = "*://www.youtube.com/*";
const CONTENT_SCRIPT_ID = "riftsight-youtube-viewer";
const CONTENT_SCRIPT_FILE = "dist/content/youtube-viewer.js";

export async function isYouTubeEnabled(): Promise<boolean> {
  return chrome.permissions.contains({ origins: [YOUTUBE_ORIGIN] });
}

/**
 * Makes dynamic-registration state match permission state, in both
 * directions. Idempotent and safe to call from anywhere, anytime; returns
 * whether YouTube is currently enabled. Registration persists across
 * browser sessions (persistAcrossSessions) so this is normally a no-op —
 * it exists for the transitions and for repair after anything odd.
 */
export async function syncYouTubeRegistration(): Promise<boolean> {
  const enabled = await isYouTubeEnabled();
  try {
    const registered = await chrome.scripting.getRegisteredContentScripts({ ids: [CONTENT_SCRIPT_ID] });
    if (enabled && registered.length === 0) {
      await chrome.scripting.registerContentScripts([
        {
          id: CONTENT_SCRIPT_ID,
          js: [CONTENT_SCRIPT_FILE],
          // All of youtube.com, not just /watch* — YouTube is an SPA, so a
          // viewer often lands on the homepage and soft-navigates to a
          // watch page with no new document load for a tighter match
          // pattern to catch. The script itself is watch-page-gated (see
          // content/youtube-viewer.ts) and near-zero-cost elsewhere.
          matches: [YOUTUBE_ORIGIN],
          runAt: "document_idle",
          persistAcrossSessions: true,
        },
      ]);
    } else if (!enabled && registered.length > 0) {
      await chrome.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] });
    }
  } catch (err) {
    // chrome.scripting can reject during permission-transition races
    // (e.g. revocation mid-call) — the next sync (boot, or the other
    // permission listener) reconverges; nothing to do now.
    console.warn("[riftsight] youtube content-script registration sync failed:", err);
  }
  return enabled;
}

/**
 * One-time catch-up for tabs that were ALREADY open when the user granted
 * the permission — dynamic registration only affects future document
 * loads, and content scripts never retroactively attach (the same
 * already-open-tab gap the RiftAtlas script has, see background.ts's
 * badge comment, except here we can actually close it because the grant
 * moment is explicit). Failures per-tab are expected and ignored:
 * discarded tabs, chrome:// error pages that matched the URL filter, etc.
 */
export async function injectIntoOpenYouTubeTabs(): Promise<void> {
  const tabs = await chrome.tabs.query({ url: YOUTUBE_ORIGIN });
  await Promise.all(
    tabs.map(async (tab) => {
      if (tab.id === undefined) return;
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: [CONTENT_SCRIPT_FILE] });
      } catch {
        // best-effort — see doc comment
      }
    })
  );
}

/** The popup's post-grant one-call path: reconverge registration, then catch up already-open tabs. */
export async function enableYouTube(): Promise<boolean> {
  const enabled = await syncYouTubeRegistration();
  if (enabled) await injectIntoOpenYouTubeTabs();
  return enabled;
}
