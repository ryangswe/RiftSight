---
description: Verify a completed milestone step — typecheck, test, build, then live-verify.
---

Run the RiftSight per-step checkpoint. Do NOT skip a stage because the change "looks safe."

1. **Typecheck all workspaces:** `npm run typecheck`
2. **Full test suite:** `npm test`
3. **Rebuild everything with a build step:** `npm run build`

If any stage fails, stop and report the failure with the actual output — do not continue to
the next stage, and do not describe the step as done.

4. **Live verification** — only if this step changed something observable in a running surface
   (relay behavior, extension, twitch-extension, debug-viewer, or site). Start the relevant
   dev server from `.claude/launch.json` via the preview tools, exercise the change, and check
   console/network/logs for errors. Skip this stage for pure type/protocol/test-only changes
   that nothing can render yet, and say why you skipped it.

Report each stage's result plainly (pass/fail), and end with a one-line summary of whether the
step is verified. If everything passed, remind me this is a good point to commit.
