// `chrome.runtime.sendMessage()` can throw *synchronously* — not just
// reject asynchronously — when the calling context has been invalidated
// (the extension was reloaded/updated while this content script's tab, or
// the popup, was still running from before the reload). Every call site in
// this codebase already chains `.catch(() => ...)` to handle the ordinary
// async-rejection failure mode, but that catch is attached to the Promise
// `sendMessage()` returns — if the call itself throws before ever
// returning a Promise, the `.catch()` is never reached at all. Confirmed
// live via chrome://extensions' Errors panel during development (rapid
// unpacked-extension reloads): both "Uncaught Error: Extension context
// invalidated." (the synchronous-throw case) and "Uncaught (in promise)
// Error: ..." (a case where the returned Promise itself still rejects
// with the same message) showed up side by side, meaning a bare
// `.catch()` alone doesn't reliably cover this failure mode.
//
// There's nothing a content script or popup can usefully do about a torn-
// down extension context beyond give up gracefully — the containing page
// needs a natural refresh to get a fresh one — so both failure shapes
// collapse to the same safe "resolve to undefined" outcome here, exactly
// matching what every existing `.catch(() => undefined)`/`.catch(() => {})`
// already intended.
export function safeSendMessage<T = unknown>(message: unknown): Promise<T | undefined> {
  try {
    return chrome.runtime.sendMessage(message) as Promise<T>;
  } catch {
    return Promise.resolve(undefined);
  }
}
