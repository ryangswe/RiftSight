import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const viewerBundlePath = path.join(packageDir, "dist/viewer/main.js");
const configBundlePath = path.join(packageDir, "dist/config/main.js");

// Distinctive enough that any match is unambiguously this test's own
// value, not a coincidental substring of something else in the bundle.
const DUMMY_SECRET = "sk_test_dummy_secret_should_never_leak_into_frontend_bundle_zzz9x";

// Every test in this file runs the REAL build.mjs/package.mjs against the
// SAME dist/ and deploy/ directories a real deploy uses — deliberately,
// with a placeholder RIFTSIGHT_RELAY_URL, to prove the security properties
// below against a genuine build rather than a re-implementation.
//
// Snapshot whatever real bundles were already on disk before this suite
// touches them, and restore those EXACT bytes afterward (regenerating
// deploy/ from the restored dist/, since package.mjs is a pure copy step)
// — rather than resetting to some fixed baseline. Two real incidents
// happened before this existed: first, `npm test` silently left deploy/
// built against "wss://example.trycloudflare.com" and a later `wrangler
// pages deploy` shipped that placeholder to production; then the first fix
// (reset to a fixed no-relay-URL baseline afterward, mirroring
// extension/src/build-manifest.test.ts's OLD afterEach) had the identical
// flaw one level up — it silently clobbered a real closed-beta build a
// developer had just made for live testing, immediately after running
// these tests. Restoring the exact prior bytes, not a fixed baseline, is
// what actually closes this class of bug regardless of what mode was
// really built before the suite ran.
const viewerBundleSnapshot = existsSync(viewerBundlePath) ? readFileSync(viewerBundlePath) : undefined;
const configBundleSnapshot = existsSync(configBundlePath) ? readFileSync(configBundlePath) : undefined;

afterEach(() => {
  if (viewerBundleSnapshot && configBundleSnapshot) {
    writeFileSync(viewerBundlePath, viewerBundleSnapshot);
    writeFileSync(configBundlePath, configBundleSnapshot);
    // deploy/ is just a copy of dist/ (plus the static html/privacy
    // files) — regenerating it from the now-restored dist/ keeps it
    // consistent with whatever was really built before this suite ran,
    // not this suite's own placeholder relay URL.
    execFileSync("node", ["scripts/package.mjs"], { cwd: packageDir, stdio: "pipe" });
  } else {
    // No prior build existed at all (a fresh checkout that's never been
    // built) — fall back to a plain build with no relay URL configured.
    execFileSync("node", ["build.mjs"], { cwd: packageDir, env: { ...process.env, RIFTSIGHT_RELAY_URL: undefined }, stdio: "pipe" });
  }
});

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

describe("package.mjs (deployable asset directory)", () => {
  it(
    "produces deploy/ containing exactly the required entry points, excluding the local mock harness pages",
    () => {
      execFileSync("node", ["build.mjs"], {
        cwd: packageDir,
        env: { ...process.env, RIFTSIGHT_RELAY_URL: "wss://example.trycloudflare.com" },
        stdio: "pipe",
      });
      execFileSync("node", ["scripts/package.mjs"], { cwd: packageDir, stdio: "pipe" });

      const deployDir = path.join(packageDir, "deploy");
      expect(existsSync(path.join(deployDir, "viewer.html"))).toBe(true);
      expect(existsSync(path.join(deployDir, "config.html"))).toBe(true);
      expect(existsSync(path.join(deployDir, "dist/viewer/main.js"))).toBe(true);
      expect(existsSync(path.join(deployDir, "dist/config/main.js"))).toBe(true);

      // The local-only mock harness (see index.html/config-mock.html's own
      // header comments) must never end up in what's deployed to the real
      // Twitch asset origin.
      expect(existsSync(path.join(deployDir, "index.html"))).toBe(false);
      expect(existsSync(path.join(deployDir, "config-mock.html"))).toBe(false);
    },
    20_000
  );

  it("deployed viewer.html/config.html load the official Twitch Extension Helper before their own bundle, with no inline <script> content (Twitch's CSP disallows it)", () => {
    for (const [file, bundlePath] of [
      ["deploy/viewer.html", "dist/viewer/main.js"],
      ["deploy/config.html", "dist/config/main.js"],
    ] as const) {
      const html = readFileSync(path.join(packageDir, file), "utf8");
      const helperIndex = html.indexOf('<script src="https://extension-files.twitch.tv/helper/v1/twitch-ext.min.js">');
      // The actual <script src="..."> tag, not just any mention of the
      // path — viewer.html's own explanatory HTML comment mentions
      // "dist/viewer/main.js" by name before the real script tags.
      const bundleIndex = html.indexOf(`<script src="${bundlePath}">`);
      expect(helperIndex).toBeGreaterThan(-1);
      expect(bundleIndex).toBeGreaterThan(helperIndex);
      expect(html).not.toMatch(/<script(?![^>]*\ssrc=)[^>]*>[^<]+<\/script>/);
    }
  });
});
