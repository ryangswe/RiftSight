import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Distinctive enough that any match is unambiguously this test's own
// value, not a coincidental substring of something else in the bundle.
const DUMMY_SECRET = "sk_test_dummy_secret_should_never_leak_into_frontend_bundle_zzz9x";

describe("twitch-extension build security", () => {
  it(
    "never embeds TWITCH_EXTENSION_SECRET into the built frontend bundles, even if it happens to be set in the environment",
    () => {
      // Simulates a realistic accident: a developer sources one shared
      // .env (or shell profile) covering both relay/ and twitch-extension/
      // env vars in the same terminal, then runs this build. build.mjs
      // must never reference TWITCH_EXTENSION_SECRET at all — this runs
      // the actual shipped build script as a real subprocess (not a
      // re-implementation that could silently drift from what ships) and
      // inspects its real output.
      execFileSync("node", ["build.mjs"], {
        cwd: packageDir,
        env: {
          ...process.env,
          TWITCH_EXTENSION_SECRET: DUMMY_SECRET,
          RIFTSIGHT_RELAY_URL: "wss://example.trycloudflare.com",
        },
        stdio: "pipe",
      });

      const viewerBundle = readFileSync(path.join(packageDir, "dist/viewer/main.js"), "utf8");
      const configBundle = readFileSync(path.join(packageDir, "dist/config/main.js"), "utf8");

      expect(viewerBundle).not.toContain(DUMMY_SECRET);
      expect(configBundle).not.toContain(DUMMY_SECRET);

      // The one value that's supposed to end up in the bundle, as a
      // sanity check that this test is actually exercising a real build
      // and not silently no-op-ing (e.g. because build.mjs failed
      // and left a stale dist/ from a previous run).
      expect(viewerBundle).toContain("wss://example.trycloudflare.com");
    },
    20_000 // real esbuild subprocess spawn — default 5s test timeout is too tight
  );
});
