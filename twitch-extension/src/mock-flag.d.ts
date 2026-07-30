export {};

declare global {
  interface Window {
    /** Set inline by index.html (the local dev mock harness) before main.js loads. Never set by viewer.html (the real Twitch-hosted page). */
    __RIFTSIGHT_MOCK__?: boolean;
  }
}
