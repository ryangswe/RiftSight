// Build script (replacing a raw `esbuild` CLI invocation) so
// RIFTSIGHT_RELAY_URL can be safely injected as a build-time constant via
// esbuild's `define` option — JSON.stringify-ing it here avoids any shell
// quoting/escaping risk a `--define:X=...` CLI flag would carry for a URL
// that might contain characters a shell treats specially.
import { build, context } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Paths are resolved relative to this script's own location, not the
// caller's cwd — makes `node build.mjs` work identically whether invoked
// from twitch-extension/ (npm scripts) or the repo root (e.g. a
// .claude/launch.json dev-server config).
const packageDir = path.dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const serve = args.includes("--serve");
const watch = args.includes("--watch");

const relayUrl = process.env.RIFTSIGHT_RELAY_URL ?? "";

const options = {
  entryPoints: [path.join(packageDir, "src/viewer/main.ts"), path.join(packageDir, "src/config/main.ts")],
  bundle: true,
  outdir: path.join(packageDir, "dist"),
  outbase: path.join(packageDir, "src"),
  absWorkingDir: packageDir,
  format: "iife",
  target: "es2020",
  define: {
    __RIFTSIGHT_RELAY_URL__: JSON.stringify(relayUrl),
  },
};

if (relayUrl) {
  console.log(`[build] RIFTSIGHT_RELAY_URL=${relayUrl}`);
} else {
  console.log("[build] RIFTSIGHT_RELAY_URL not set — real Twitch mode will fail fast with a clear diagnostic until it is.");
}

if (serve) {
  const ctx = await context(options);
  await ctx.watch();
  const { host, port } = await ctx.serve({ servedir: packageDir, port: 8789 });
  console.log(`[build] serving on http://${host === "0.0.0.0" ? "localhost" : host}:${port}`);
} else if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log("[build] watching for changes...");
} else {
  await build(options);
}
