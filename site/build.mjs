// Produces dist/ — the exact set of static files to deploy for the RiftSight
// landing site. The site is plain HTML/CSS with one small config script, with
// one exception: the interactive "See it in action" demo is a TypeScript
// module that imports the shared @riftsight/overlay-core + @riftsight/protocol
// packages, so it's bundled here with esbuild into assets/demo.bundle.js
// (the same real overlay code the Twitch viewer runs). Everything else is
// copied verbatim. Fails loudly if a required file is missing.
//
// Cloudflare Pages: use Build command `npm run build` (from site/) with Output
// dir `site/dist`. Serving the source directory statically also works, but the
// demo needs assets/demo.bundle.js built first (`npm run build -w site`);
// without it the demo degrades gracefully to the static board screenshot.
import { existsSync, mkdirSync, copyFileSync, rmSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";

const pkgDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(pkgDir, "dist");

// Bundle the interactive demo module first, so the copy step below picks up
// the freshly built assets/demo.bundle.js.
await esbuild({
  entryPoints: [path.join(pkgDir, "src/demo.ts")],
  bundle: true,
  format: "iife",
  target: "es2020",
  minify: true,
  outfile: path.join(pkgDir, "assets", "demo.bundle.js"),
  logLevel: "info",
});
console.log("[site] bundled assets/demo.bundle.js");

// Top-level files that must exist and get copied verbatim.
const REQUIRED_FILES = ["index.html", "setup.html", "config.js", "site.js", "site.css", "privacy.html", "eula.html"];
const missing = REQUIRED_FILES.filter((f) => !existsSync(path.join(pkgDir, f)));
if (missing.length > 0) {
  console.error(`[site] missing required file(s): ${missing.join(", ")}`);
  process.exit(1);
}

function copyDir(srcDir, destDir) {
  mkdirSync(destDir, { recursive: true });
  for (const entry of readdirSync(srcDir)) {
    const src = path.join(srcDir, entry);
    const dest = path.join(destDir, entry);
    if (statSync(src).isDirectory()) copyDir(src, dest);
    else copyFileSync(src, dest);
  }
}

rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });
for (const file of REQUIRED_FILES) copyFileSync(path.join(pkgDir, file), path.join(distDir, file));

const assetsSrc = path.join(pkgDir, "assets");
if (!existsSync(assetsSrc)) {
  console.error("[site] missing required assets/ directory");
  process.exit(1);
}
copyDir(assetsSrc, path.join(distDir, "assets"));

// The interactive demo's fixture + board screenshot + card art.
const demoSrc = path.join(pkgDir, "demo");
if (existsSync(demoSrc)) copyDir(demoSrc, path.join(distDir, "demo"));

console.log(`[site] wrote deployable static site: ${distDir}`);
