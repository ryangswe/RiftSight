// Injected by build.mjs via esbuild's `define` option — build-time
// literals, not runtime globals. See RIFTSIGHT_MODE/RIFTSIGHT_BACKEND_URL
// in .env.example.
export {};

declare global {
  const __RIFTSIGHT_MODE__: "development" | "twitch-local-test" | "closed-beta";
  const __RIFTSIGHT_BACKEND_URL__: string;
}
