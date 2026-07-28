// Watches the RiftAtlas board for DOM changes and calls back, debounced, so
// callers aren't re-scanning on every animation frame or micro-mutation
// (RiftAtlas's board re-renders frequently — hover states, counters, etc.).
// Deliberately thin/browser-glue: the logic actually worth unit-testing
// (dedup, sequencing) lives in @riftsight/protocol's OverlayStatePublisher,
// which this only triggers.

const DEBOUNCE_MS = 300;

// The board root RiftAtlas renders under (see card-detector.ts's captured
// evidence — `section.gb-board`). Falls back to document.body if that
// selector ever changes; watching the whole body just means more
// mutation events to debounce through, not incorrect behavior.
const BOARD_ROOT_SELECTOR = "section.gb-board, body";

export interface CardObserverHandle {
  disconnect(): void;
}

export function observeBoard(onChange: () => void): CardObserverHandle {
  const root = document.querySelector(BOARD_ROOT_SELECTOR) ?? document.body;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const scheduleChange = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      onChange();
    }, DEBOUNCE_MS);
  };

  const observer = new MutationObserver(scheduleChange);
  observer.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["data-card-id", "data-drop-zone", "data-preview-rotation", "style", "class"],
  });

  // Fire once immediately so callers get an initial snapshot without
  // waiting for the first mutation.
  scheduleChange();

  return {
    disconnect(): void {
      observer.disconnect();
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}
