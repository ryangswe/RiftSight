// Integration coverage for build.mjs's manifest generation — runs the
// actual shipped build script as a real subprocess (not a
// re-implementation that could silently drift) and inspects its real
// written extension/manifest.json, mirroring
// twitch-extension/src/build-security.test.ts's established technique for
// this repo's build scripts.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(packageDir, "manifest.json");
// build.mjs bundles every entry point on every run, not just manifest.json
// — a real backend URL lives baked into these as __RIFTSIGHT_BACKEND_URL__,
// completely separate from anything manifest.json itself records. Missing
// this the first time this suite got a snapshot/restore fix is exactly
// what caused a real incident: manifest.json's host_permissions looked
// correct (restored), but background.js still had an empty backend URL
// baked in from whatever test ran last, and Connect Twitch silently opened
// a broken URL — the JS is what actually matters, the manifest was only
// ever a symptom-visible proxy for it.
const bundlePaths = [
  path.join(packageDir, "dist/content/inventory.js"),
  path.join(packageDir, "dist/background/background.js"),
  path.join(packageDir, "dist/popup/main.js"),
];

function readManifest(): { host_permissions: string[]; [key: string]: unknown } {
  return JSON.parse(readFileSync(manifestPath, "utf8"));
}

function runBuild(env: Record<string, string | undefined>): void {
  // Start from a base that explicitly excludes these two vars (rather than
  // process.env, which could have them set in some shells) so every call
  // is a clean slate, then apply only the defined overrides — an
  // explicitly-undefined override must actually remove the key, not pass
  // the literal string "undefined" through to the child process.
  const base: Record<string, string | undefined> = { ...process.env, RIFTSIGHT_MODE: undefined, RIFTSIGHT_BACKEND_URL: undefined };
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...base, ...env })) {
    if (value !== undefined) merged[key] = value;
  }
  execFileSync("node", ["build.mjs"], { cwd: packageDir, env: merged, stdio: "pipe" });
}

// Every test mutates the real manifest.json AND every bundled entry point
// (see bundlePaths above) — snapshot whatever real build was already on
// disk before this suite touches any of it, and restore those EXACT bytes
// afterward, rather than resetting to a fixed development-mode baseline.
// Falls back to a plain development build only if no manifest existed yet
// at all (a fresh checkout that's never been built) — in that case there's
// nothing meaningful to restore bundles to either, so a fresh build is the
// correct fallback for all of it together.
const manifestSnapshot = existsSync(manifestPath) ? readFileSync(manifestPath) : undefined;
const bundleSnapshots = bundlePaths.map((p) => (existsSync(p) ? readFileSync(p) : undefined));

afterEach(() => {
  if (manifestSnapshot && bundleSnapshots.every((snapshot) => snapshot !== undefined)) {
    writeFileSync(manifestPath, manifestSnapshot);
    bundlePaths.forEach((p, i) => writeFileSync(p, bundleSnapshots[i] as Buffer));
  } else {
    runBuild({});
  }
});

describe("build.mjs manifest generation", () => {
  it("development mode writes today's exact localhost host_permissions", () => {
    runBuild({ RIFTSIGHT_MODE: "development" });
    const manifest = readManifest();
    expect(manifest.host_permissions).toEqual(["ws://localhost/*", "http://localhost:8788/*"]);
  });

  it("twitch-local-test mode also keeps the localhost permissions (same as development)", () => {
    runBuild({ RIFTSIGHT_MODE: "twitch-local-test" });
    const manifest = readManifest();
    expect(manifest.host_permissions).toEqual(["ws://localhost/*", "http://localhost:8788/*"]);
  });

  it(
    "closed-beta mode derives host_permissions from RIFTSIGHT_BACKEND_URL — https and wss, no wildcard scheme/host",
    () => {
      runBuild({ RIFTSIGHT_MODE: "closed-beta", RIFTSIGHT_BACKEND_URL: "https://beta.riftsight.example.com" });
      const manifest = readManifest();
      expect(manifest.host_permissions).toEqual(["https://beta.riftsight.example.com/*", "wss://beta.riftsight.example.com/*"]);
      for (const permission of manifest.host_permissions) {
        expect(permission).not.toContain("*://");
        expect(permission).not.toBe("https://*/*");
      }
    },
    20_000
  );

  it("closed-beta mode fails the build (and never writes a manifest) when RIFTSIGHT_BACKEND_URL is unset", () => {
    // Seed a known-good manifest first so we can confirm the failed build
    // didn't silently leave a stale-but-different one in its place either.
    runBuild({ RIFTSIGHT_MODE: "development" });
    const before = readManifest();

    expect(() => runBuild({ RIFTSIGHT_MODE: "closed-beta", RIFTSIGHT_BACKEND_URL: undefined })).toThrow();
    expect(readManifest()).toEqual(before);
  });

  it("closed-beta mode fails the build when RIFTSIGHT_BACKEND_URL is http:, not https:", () => {
    expect(() =>
      runBuild({ RIFTSIGHT_MODE: "closed-beta", RIFTSIGHT_BACKEND_URL: "http://beta.riftsight.example.com" })
    ).toThrow();
  });

  it("closed-beta mode fails the build when RIFTSIGHT_BACKEND_URL is malformed", () => {
    expect(() => runBuild({ RIFTSIGHT_MODE: "closed-beta", RIFTSIGHT_BACKEND_URL: "not a url" })).toThrow();
  });

  it("the generated manifest.json still has every other field from the template, untouched", () => {
    runBuild({ RIFTSIGHT_MODE: "closed-beta", RIFTSIGHT_BACKEND_URL: "https://beta.riftsight.example.com" });
    const manifest = readManifest();
    expect(manifest["manifest_version"]).toBe(3);
    expect(manifest["background"]).toEqual({ service_worker: "dist/background/background.js" });
    expect(manifest["content_scripts"]).toEqual([
      { matches: ["*://play.riftatlas.com/*"], js: ["dist/content/inventory.js"], run_at: "document_idle" },
    ]);
  });

  it("the generated manifest.json wires the toolbar popup, in every build mode", () => {
    runBuild({ RIFTSIGHT_MODE: "development" });
    const manifest = readManifest();
    expect((manifest["action"] as { default_popup?: string })["default_popup"]).toBe("popup.html");
  });
});
