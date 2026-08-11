// Produces dist/ — the exact set of static files to deploy for the RiftSight
// landing site. There is no bundling or transpiling here: the site is plain
// HTML/CSS with one small config script. This script exists so the package
// participates in the monorepo's `npm run build -ws` and so a deploy artifact
// (dist/) can be pointed at directly. It fails loudly if a required file is
// missing, catching an incomplete tree before anything is uploaded.
//
// Cloudflare Pages can serve either this dist/ (Build command: `npm run build`,
// Output dir: `site/dist`) or the source directory as-is with no build step.
import { existsSync, mkdirSync, copyFileSync, rmSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(pkgDir, "dist");

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

console.log(`[site] wrote deployable static site: ${distDir}`);
