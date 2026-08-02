// Produces deploy/ — the exact, minimal set of files that should be
// uploaded to the stable Twitch asset-hosting origin (entered as the
// Twitch Developer Console's "Testing Base URI" for the closed-beta
// version — see README). Deliberately excludes index.html and
// config-mock.html: those are the LOCAL MOCK HARNESS ONLY (see their own
// header comments), never loaded by Twitch, and never appropriate to
// serve from the real asset origin — only viewer.html/config.html load
// the official Twitch Extension Helper script and are built against
// Twitch's CSP.
//
// Run after `node build.mjs` (or via `npm run package`, which runs both).
// Fails loudly (nonzero exit) if any required entry point is missing —
// this is the "integrity check" that a broken or incomplete build is
// caught here, before anything gets uploaded, rather than surfacing as a
// blank overlay for a live streamer.

import { existsSync, mkdirSync, copyFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const deployDir = path.join(packageDir, "deploy");

// Relative to packageDir. Every one of these must exist post-build, and
// this exact list is what gets copied into deploy/ — nothing more, so a
// stray dev-only file can never accidentally end up on the real Twitch
// asset origin just because it happened to be sitting in this directory.
const REQUIRED_FILES = ["viewer.html", "config.html", "dist/viewer/main.js", "dist/config/main.js"];

const missing = REQUIRED_FILES.filter((file) => !existsSync(path.join(packageDir, file)));
if (missing.length > 0) {
  console.error(`[package] missing required build output, run "node build.mjs" first: ${missing.join(", ")}`);
  process.exit(1);
}

rmSync(deployDir, { recursive: true, force: true });
for (const file of REQUIRED_FILES) {
  const dest = path.join(deployDir, file);
  mkdirSync(path.dirname(dest), { recursive: true });
  copyFileSync(path.join(packageDir, file), dest);
}

console.log(`[package] wrote a deployable asset directory: ${deployDir}`);
console.log("[package] upload this directory's contents to your stable HTTPS asset origin, then set that origin");
console.log('[package] as the Twitch Developer Console\'s "Testing Base URI" for the closed-beta version.');
