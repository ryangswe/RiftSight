// Pure resume/stop decision for inventory.ts's heartbeat tick and click
// handler — split out so the actual rule ("when does publishing.ts's
// startPublishing()/stopPublishing() get called") is directly
// unit-testable, matching this repo's established "pure logic tested,
// chrome.*/DOM-touching glue thin" split (see presence.ts and
// connection-diagnostics.ts for the same pattern).
//
// `intent` is the streamer's persisted desire to be publishing
// (background/publishing-intent.ts, chrome.storage.local-backed) — kept
// deliberately separate from `isPublishing` (publisher.ts's actual current
// state) and `boardDetected` (this instant's DOM reality). Reload,
// tab-close/reopen, and a worker restart all change nothing about this
// function's inputs or behavior: intent survives all three via
// chrome.storage.local, and this function only ever cares about the three
// current values, never how they got there.

export interface PublishingLifecycleInput {
  /** The streamer's persisted desire to be publishing — false only when nothing has ever asked for it, or an explicit Stop click set it false. */
  intent: boolean;
  /** RiftAtlas's own game-board DOM root is present right now (card-observer.ts's isGameBoardDetected()) — independent of whether any cards currently happen to be on it. */
  boardDetected: boolean;
  /** publisher.ts's isPublishing() — whether an observer is actively running right now. */
  isPublishing: boolean;
}

export type PublishingLifecycleAction = "start" | "stop" | "none";

/**
 * "start": intent is on, a board just became available, and nothing is
 * running yet — resume without requiring another click. "stop": actively
 * publishing but the board just disappeared — pause (does NOT touch
 * intent; only an explicit Stop click does that, see inventory.ts). "none"
 * covers every steady state, including intent being off (explicit Stop
 * means this never resumes on its own, no matter how many times a board
 * reappears) and already being in the right state.
 */
export function nextPublishingAction(input: PublishingLifecycleInput): PublishingLifecycleAction {
  if (input.intent && input.boardDetected && !input.isPublishing) return "start";
  if (input.isPublishing && !input.boardDetected) return "stop";
  return "none";
}
