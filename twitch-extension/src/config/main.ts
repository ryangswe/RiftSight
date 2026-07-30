// Broadcaster configuration page entry point. Twitch only ever shows this
// to the broadcaster (and extension editors) for their own channel — that
// access restriction is enforced by Twitch's platform, not this code;
// normal viewers never load this page at all. Same mock/real branching
// convention as src/viewer/main.ts.
import { DEFAULT_OVERLAY_CONFIG, OVERLAY_CONFIG_VERSION, parseOverlayConfig, serializeOverlayConfig, type OverlayConfig } from "./overlay-config.js";

const isMock = window.__RIFTSIGHT_MOCK__ === true;
const MOCK_STORAGE_KEY = "riftsight-mock-broadcaster-config";

function requireElement<T extends Element>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el as unknown as T;
}

const overlayEnabledInput = requireElement<HTMLInputElement>("overlay-enabled-input");
const delayInput = requireElement<HTMLInputElement>("delay-input");
const debugOutlinesInput = requireElement<HTMLInputElement>("debug-outlines-input");
const aspectRatioInput = requireElement<HTMLInputElement>("aspect-ratio-input");
const saveButton = requireElement<HTMLButtonElement>("save-button");
const statusText = requireElement<HTMLElement>("status-text");

function applyToForm(config: OverlayConfig): void {
  overlayEnabledInput.checked = config.overlayEnabled;
  delayInput.value = String(config.delayMs);
  debugOutlinesInput.checked = config.debugOutlines;
  aspectRatioInput.value = config.sourceAspectRatio !== undefined ? String(config.sourceAspectRatio) : "";
}

function readFromForm(): OverlayConfig {
  const parsedAspectRatio = Number.parseFloat(aspectRatioInput.value);
  return {
    overlayEnabled: overlayEnabledInput.checked,
    delayMs: Math.max(0, Number.parseInt(delayInput.value, 10) || 0),
    debugOutlines: debugOutlinesInput.checked,
    sourceAspectRatio: Number.isFinite(parsedAspectRatio) && parsedAspectRatio > 0 ? parsedAspectRatio : undefined,
  };
}

Array.from(document.querySelectorAll<HTMLButtonElement>("[data-delay-preset]")).forEach((button) => {
  button.addEventListener("click", () => {
    delayInput.value = button.dataset["delayPreset"] ?? "0";
  });
});

if (isMock) {
  const stored = localStorage.getItem(MOCK_STORAGE_KEY) ?? undefined;
  applyToForm(parseOverlayConfig(stored));
  statusText.textContent = "mock mode — saved to localStorage, not Twitch";

  saveButton.addEventListener("click", () => {
    localStorage.setItem(MOCK_STORAGE_KEY, serializeOverlayConfig(readFromForm()));
    statusText.textContent = `saved to localStorage at ${new Date().toLocaleTimeString()}`;
  });
} else {
  applyToForm(DEFAULT_OVERLAY_CONFIG);
  statusText.textContent = "Waiting for Twitch authorization…";
  saveButton.disabled = true;

  if (!window.Twitch?.ext) {
    statusText.textContent = "Twitch Extension Helper not found — this page must be loaded inside a Twitch extension iframe.";
  } else {
    const twitch = window.Twitch.ext;
    twitch.onAuthorized(() => {
      saveButton.disabled = false;
      applyToForm(parseOverlayConfig(twitch.configuration.broadcaster?.content));
      statusText.textContent = "Ready.";
    });

    twitch.onError((error) => {
      console.warn("[twitch-extension] Twitch Helper reported an error", error);
      statusText.textContent = "Twitch authorization failed — see console for details.";
    });

    saveButton.addEventListener("click", () => {
      twitch.configuration.set("broadcaster", OVERLAY_CONFIG_VERSION, serializeOverlayConfig(readFromForm()));
      statusText.textContent = `saved at ${new Date().toLocaleTimeString()}`;
    });
  }
}
