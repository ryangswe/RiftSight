# Plans

Durable implementation plans, so a **fresh conversation** — often a different model from the one
that wrote the plan — can execute the work from the file alone, without the planning transcript.

This is the handoff for large milestones (Pattern C): a Fable planning conversation designs and
writes the plan here; a later Opus conversation reads it and implements. The plan is the
interface between them, so it has to stand on its own.

## Naming

`YYYY-MM-DD-<short-slug>.md` — e.g. `2026-08-17-youtube-auth.md`. Date is when the plan was
written. One file per milestone/effort.

## Lifecycle

- **Draft** while planning. Get it reviewed (by you) before any code is touched.
- **In progress** — the implementing conversation checks off steps as it lands them (each step
  should survive `/checkpoint` on its own).
- **Done** — when every step is verified and committed. Leave the file in place as a record; it
  pairs with `docs/decisions.md` (the plan is *how*, decisions.md is *why*).

Don't force small tasks through this — a bug fix or one-sitting feature doesn't need a plan file.
Use it when work is large, will be split across worktrees, or handed to a cold conversation.

## Template

Copy `_template.md` to a new dated file to start.
