// Build script (replacing a raw `esbuild` CLI invocation) so RIFTSIGHT_MODE
// and RIFTSIGHT_BACKEND_URL can be injected as build-time constants via
// esbuild's `define` option, mirroring twitch-extension/build.mjs's exact
// pattern (JSON.stringify avoids shell-quoting risk, and both packages use
// the same env var *names* for the same concept even though relay reads
// RIFTSIGHT_MODE at runtime and this bakes it in at build time instead —
// the extension is a static, unpacked build with no running process to
// read env vars from).
//
// Also generates manifest.json from manifest.template.json on every build.
// manifest.json's host_permissions has to match whatever backend origin
// this same build is configured to talk to — a manual edit is exactly the
// kind of thing that gets forgotten right before a real deployment, so
// it's derived here instead. The template holds everything else
// (name/description/entry points) plus the development-mode
// host_permissions verbatim; manifest.json itself is now a build output
// (gitignored, like dist/), not something to hand-edit.
import { build, context } from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const packageDir = path.dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const watch = args.includes("--watch");

const mode = process.env.RIFTSIGHT_MODE || "development";
const backendUrl = process.env.RIFTSIGHT_BACKEND_URL ?? "";

/**
 * development/twitch-local-test: today's localhost permissions, taken
 * verbatim from the template — unchanged from before this build-time
 * generation existed. closed-beta: derived from RIFTSIGHT_BACKEND_URL,
 * both the https (fetch, for OAuth linking) and wss (the authenticated
 * producer WebSocket) variants of the same host — never a wildcard
 * scheme or host, and never silently falling back to localhost if the
 * URL is missing/insecure/malformed (fails the build instead, matching
 * twitch-extension/build.mjs's existing RIFTSIGHT_RELAY_URL fail-fast
 * precedent).
 */
export function computeHostPermissions(mode, backendUrl, devHostPermissions) {
  if (mode !== "closed-beta") {
    return devHostPermissions;
  }
  if (!backendUrl) {
    throw new Error(
      "RIFTSIGHT_BACKEND_URL is required in closed-beta mode to build the extension's manifest — set it to your deployed backend's https:// origin."
    );
  }
  let parsed;
  try {
    parsed = new URL(backendUrl);
  } catch {
    throw new Error(`RIFTSIGHT_BACKEND_URL is not a valid URL: "${backendUrl}"`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(
      `RIFTSIGHT_BACKEND_URL must use https: in closed-beta mode (got "${parsed.protocol}") — refusing to grant an insecure backend origin rather than silently allowing it.`
    );
  }
  return [`https://${parsed.host}/*`, `wss://${parsed.host}/*`];
}

function writeManifest() {
  const template = JSON.parse(readFileSync(path.join(packageDir, "manifest.template.json"), "utf8"));
  const manifest = { ...template, host_permissions: computeHostPermissions(mode, backendUrl, template.host_permissions) };
  writeFileSync(path.join(packageDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(`[build] wrote manifest.json with host_permissions: ${JSON.stringify(manifest.host_permissions)}`);
}

const options = {
  entryPoints: [
    path.join(packageDir, "src/content/inventory.ts"),
    path.join(packageDir, "src/background/background.ts"),
    path.join(packageDir, "src/popup/main.ts"),
  ],
  bundle: true,
  outdir: path.join(packageDir, "dist"),
  outbase: path.join(packageDir, "src"),
  absWorkingDir: packageDir,
  format: "iife",
  target: "es2020",
  define: {
    __RIFTSIGHT_MODE__: JSON.stringify(mode),
    __RIFTSIGHT_BACKEND_URL__: JSON.stringify(backendUrl),
  },
};

console.log(`[build] RIFTSIGHT_MODE=${mode}`);
if (backendUrl) {
  console.log(`[build] RIFTSIGHT_BACKEND_URL=${backendUrl}`);
} else if (mode === "closed-beta") {
  console.log("[build] RIFTSIGHT_BACKEND_URL not set — account linking will fail fast with a clear diagnostic until it is.");
}

// Fails the whole build (via the thrown error) if closed-beta mode can't
// compute a safe manifest — never leaves a stale/wrong manifest.json in
// place from a previous build.
writeManifest();

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log("[build] watching for changes...");
} else {
  await build(options);
}
