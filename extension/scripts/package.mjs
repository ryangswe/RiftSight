// Produces riftsight-extension.zip — the exact, minimal set of files Chrome
// needs to load this as an unpacked extension: manifest.json, popup.html,
// icons/, and the esbuild dist/ output. Run after `node build.mjs` (or via
// `npm run package`, which runs both), mirroring
// twitch-extension/scripts/package.mjs's exact pattern.
//
// Writes to ~/Downloads by default (RIFTSIGHT_ZIP_OUTPUT_DIR overrides),
// falling back to this package's own directory if Downloads doesn't exist.
// Fails loudly (nonzero exit) if any required build output is missing —
// caught here rather than shipping a broken zip to a streamer.

import { existsSync, mkdirSync, mkdtempSync, cpSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Relative to packageDir. Every one of these must exist post-build, and
// this exact list is what gets staged into the zip — nothing more, so a
// stray dev-only file can never accidentally ship to a streamer just
// because it happened to be sitting in this directory.
const REQUIRED_FILES = [
  "manifest.json",
  "popup.html",
  "icons/icon16.png",
  "icons/icon48.png",
  "icons/icon128.png",
  "dist/background/background.js",
  "dist/content/inventory.js",
  "dist/popup/main.js",
];

const missing = REQUIRED_FILES.filter((file) => !existsSync(path.join(packageDir, file)));
if (missing.length > 0) {
  console.error(`[package] missing required build output, run "node build.mjs" first: ${missing.join(", ")}`);
  process.exit(1);
}

const stageRoot = mkdtempSync(path.join(os.tmpdir(), "riftsight-extension-"));
const stageDir = path.join(stageRoot, "riftsight-extension");
for (const file of REQUIRED_FILES) {
  const dest = path.join(stageDir, file);
  mkdirSync(path.dirname(dest), { recursive: true });
  cpSync(path.join(packageDir, file), dest);
}

const downloadsDir = path.join(os.homedir(), "Downloads");
const outputDir = process.env.RIFTSIGHT_ZIP_OUTPUT_DIR || (existsSync(downloadsDir) ? downloadsDir : packageDir);
const zipPath = path.join(outputDir, "riftsight-extension.zip");

rmSync(zipPath, { force: true }); // `zip` appends to an existing archive rather than replacing it — always start clean.
try {
  execFileSync("zip", ["-r", zipPath, "riftsight-extension"], { cwd: stageRoot, stdio: "inherit" });
} catch (err) {
  if (err.code === "ENOENT") {
    console.error('[package] the "zip" command isn\'t available on this system — install it, or extract the staged files yourself from:', stageDir);
    process.exit(1);
  }
  throw err;
} finally {
  rmSync(stageRoot, { recursive: true, force: true });
}

console.log(`[package] wrote ${zipPath}`);
console.log('[package] in chrome://extensions: remove the existing RiftSight entry, unzip this file, then "Load unpacked" the extracted riftsight-extension/ folder.');

// Also refresh the copy the public site serves as its "Download the extension"
// button (site/assets/riftsight-extension.zip), so the download always matches
// the latest build. Skipped quietly if the site package isn't present.
const repoRoot = path.dirname(packageDir);
const siteAssetsDir = path.join(repoRoot, "site", "assets");
if (existsSync(siteAssetsDir)) {
  const siteZip = path.join(siteAssetsDir, "riftsight-extension.zip");
  cpSync(zipPath, siteZip);
  console.log(`[package] also updated the site download: ${siteZip}`);
}
