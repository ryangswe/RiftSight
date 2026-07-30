// DOM glue around one OverlayRecorder instance — start/stop/clear/export/
// import buttons. The actual recording logic (dedup, offsetMs, validation)
// lives in @riftsight/protocol and is unit-tested there; this file only
// wires it to the page.

import { OverlayRecorder, parseRecording, type OverlayRecording, type OverlayState } from "@riftsight/protocol";

export interface RecordingControlsElements {
  startButton: HTMLButtonElement;
  stopButton: HTMLButtonElement;
  clearButton: HTMLButtonElement;
  exportButton: HTMLButtonElement;
  importInput: HTMLInputElement;
  statusText: HTMLElement;
}

export interface RecordingControls {
  recorder: OverlayRecorder;
  /** Call on every incoming live state — no-ops internally unless actively recording. */
  recordIfActive(state: OverlayState): void;
}

export function setupRecordingControls(
  elements: RecordingControlsElements,
  onRecordingImported: (recording: OverlayRecording) => void
): RecordingControls {
  const recorder = new OverlayRecorder();

  function refresh(): void {
    elements.startButton.disabled = recorder.isRecording();
    elements.stopButton.disabled = !recorder.isRecording();
    elements.exportButton.disabled = recorder.length === 0;

    if (recorder.isRecording()) {
      elements.statusText.textContent = `recording... ${recorder.length} state(s)`;
    } else if (recorder.length > 0) {
      elements.statusText.textContent = `stopped — ${recorder.length} state(s)`;
    } else {
      elements.statusText.textContent = "not recording";
    }
  }

  elements.startButton.addEventListener("click", () => {
    recorder.start();
    console.log("[recording] started");
    refresh();
  });

  elements.stopButton.addEventListener("click", () => {
    const count = recorder.length;
    recorder.stop();
    console.log(`[recording] stopped (${count} state(s))`);
    refresh();
  });

  elements.clearButton.addEventListener("click", () => {
    recorder.clear();
    console.log("[recording] cleared");
    refresh();
  });

  elements.exportButton.addEventListener("click", () => {
    const recording = recorder.toRecording();
    if (!recording) return;

    const blob = new Blob([JSON.stringify(recording, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `riftsight-recording-${recording.createdAt}.json`;
    link.click();
    URL.revokeObjectURL(url);
    console.log(`[recording] exported ${recording.states.length} state(s)`);
  });

  elements.importInput.addEventListener("change", () => {
    const file = elements.importInput.files?.[0];
    elements.importInput.value = ""; // allow re-selecting the same file later
    if (!file) return;

    file
      .text()
      .then((text) => {
        const result = parseRecording(text);
        if ("error" in result) {
          console.warn(`[recording] rejected import: ${result.error}`);
          elements.statusText.textContent = `import failed: ${result.error}`;
          return;
        }
        console.log(`[recording] imported ${result.recording.states.length} state(s)`);
        elements.statusText.textContent = `loaded recording — ${result.recording.states.length} state(s), ${(
          result.recording.durationMs / 1000
        ).toFixed(1)}s`;
        onRecordingImported(result.recording);
      })
      .catch(() => {
        console.warn("[recording] failed to read the imported file");
        elements.statusText.textContent = "import failed: could not read file";
      });
  });

  refresh();

  return {
    recorder,
    recordIfActive(state: OverlayState): void {
      if (!recorder.isRecording()) return;
      recorder.record(state);
      refresh();
    },
  };
}
