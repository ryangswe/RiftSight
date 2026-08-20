# <Milestone / effort title>

- **Date:** YYYY-MM-DD
- **Status:** Draft | In progress | Done
- **Planned by:** <model, e.g. Fable 5>
- **Spec / source:** <link or one-line pointer to the request this came from>

## Goal

What this milestone delivers, in 2-4 sentences. State the scope boundary explicitly — what this
deliberately does NOT build yet, and why (RiftSight milestones build toward future goals without
implementing them prematurely).

## Approach

The architecture: which workspaces change, where the seams are, and any `protocol/` or other
shared-type coupling that forces both sides to change together.

## Alternatives considered

- **<Rejected approach>** — why not. Promote anything worth remembering long-term into
  `docs/decisions.md`.

## Risks / open questions

Anything needing a human decision before coding starts. Resolve these before moving to Draft →
In progress.

## Steps

Small, individually verifiable units in execution order. Each should survive `/checkpoint`
(typecheck → test → build → verify) on its own. Name the files each step touches.

- [ ] **1.** <step> — files: `path/a.ts`, `path/b.ts`
- [ ] **2.** <step> — files: `...`
- [ ] **3.** <step> — files: `...`

## Verification

How we know the whole milestone works end-to-end beyond per-step checkpoints (manual QA steps,
a specific surface to exercise, etc.).
