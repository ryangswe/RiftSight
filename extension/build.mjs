// Build script (replacing a raw `esbuild` CLI invocation) so RIFTSIGHT_MODE
// and RIFTSIGHT_BACKEND_URL can be injected as build-time constants via
// esbuild's `define` option, mirroring twitch-extension/build.mjs's exact
// pattern (JSON.stringify avoids shell-quoting risk, and both packages use
// the same env var *names* for the same concept even though relay reads
// RIFTSIGHT_MODE at runtime and this bakes it in at build time instead —
// the extension is a static, unpacked build with no running process to
// read env vars from).
import { build, context } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";

const packageDir = path.dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const watch = args.includes("--watch");

const mode = process.env.RIFTSIGHT_MODE || "development";
const backendUrl = process.env.RIFTSIGHT_BACKEND_URL ?? "";

const options = {
  entryPoints: [path.join(packageDir, "src/content/inventory.ts"), path.join(packageDir, "src/background/background.ts")],
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

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log("[build] watching for changes...");
} else {
  await build(options);
}
