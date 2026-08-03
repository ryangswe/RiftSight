// Integration coverage for build.mjs's manifest generation — runs the
// actual shipped build script as a real subprocess (not a
// re-implementation that could silently drift) and inspects its real
// written extension/manifest.json, mirroring
// twitch-extension/src/build-security.test.ts's established technique for
// this repo's build scripts.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(packageDir, "manifest.json");

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

// Every test mutates the real manifest.json — restore it to the ordinary
// development build afterward so the repo is left in a normal, loadable
// state (matches what a plain `npm run build -w extension` produces) and
// so test order/failures never leave a closed-beta manifest lying around
// for someone to accidentally load unpacked.
afterEach(() => {
  runBuild({});
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
});
