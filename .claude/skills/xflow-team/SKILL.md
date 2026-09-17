---
name: xflow-team
description: Use when an xflow change touches MULTIPLE independent modules that can be implemented in parallel — spawns one agent per module ("member") in the repo root, respecting cross-module dependencies, so implementation runs concurrently instead of module-by-module. Framework-default and OpenCode-only; single-module or tightly-coupled changes should stay sequential.
---

# Parallel module-grain agent teams

## When to use

- The active change has ≥ 2 `affected_modules` that can progress independently.
- Keep the lead agent focused on coordination while member agents implement in parallel.
- Modules with a strict dependency chain (A must finish before B can start) are still handled — the team scheduler blocks B until A completes.

## Overview

xflow's parallel grain is the **module**. Each member is an agent that owns exactly one
module and works in the shared repo root. Members whose module depends on another wait
until the upstream module completes (dependency edges come from `xf-deps`). The lead
(you) drives scheduling ticks and collects results.

**Known v1 limitation:** members are independent — there is **no mailbox / live
inter-agent messaging**. Coordination happens only through module dependency edges.

**Announce at start:** "I'm using the xflow-team skill to run modules in parallel."

## Preconditions

- Platform is OpenCode (the `team_*` tools ship in the OpenCode team plugin).
- There is an active change with ≥ 2 `affected_modules` (check `xspec/**/changes/change.yaml`).
- Each module has a `task.md` (so dependencies can be derived). Run `/xf:task` first if not.

## Step 1: Inspect the dependency graph

```bash
node .xflow/scripts/xf-current-change.mjs
node .xflow/scripts/xf-deps.mjs --module <one-of-the-modules>
```

Use this to understand which modules can start immediately and which must wait for others.
The team scheduler handles the blocking automatically — you don't need to sequence them manually.

## Step 2: Create the team

`team_create` reads `affected_modules`, assigns one member per module, wires cross-module
`blockedBy` from `xf-deps`, and starts every member whose module has no unmet dependency.

- `name` — optional team name.

It returns a `teamRunId` and the first wave of started members. Members whose modules are
still blocked stay pending until their dependencies complete.

## Step 3: Advance the schedule

`team_wait` is **blocking**: internally it ticks (reconcile + dispatch) every few seconds
and only returns when **a member finishes**, **the whole team completes**, or its
**timeout** elapses. Call it **once and wait** — do NOT loop back-to-back calls.

- `team_wait` — blocks, auto-advancing the schedule. Returns a `reason`
  (`complete` / `progress` / `timeout`) plus `justCompleted` / `justStarted` and the full
  status snapshot. `timeoutSec` (default 600) caps how long one call blocks.
- `team_status` — read-only snapshot any time you want a progress check without advancing.

Pattern: call `team_wait`; when it returns, if `complete=false` call `team_wait` once
more; repeat. A failed member returns its task to `pending` and the next `team_wait`
retries it.

## Human visibility (automatic)

The human sees team progress live in the TUI without you doing anything:

- **Toasts** pop when a member finishes or fails.
- **Sidebar widget** shows aggregate counts and per-module status, refreshing every few seconds.

## Step 4: Clean up

Once the team is complete:

1. Review the changes produced by each member.
2. Call `team_delete` to clean up the team's runtime state.
3. Proceed to `/xf:archive` as usual.

## Guardrails

- One member per module — never two members on the same module.
- Do not hand-roll `opencode run` for members; use `team_create`.
- Members run in the background; the lead ticks with `team_wait`. Do not busy-wait.

`team_create` reads `affected_modules`, assigns one member per module, wires cross-module
`blockedBy` from `xf-deps`, and starts every member whose module has no unmet dependency.

- `name` — optional team name.

It returns a `teamRunId` and the first wave of started members. Members whose modules are
still blocked stay pending.

## Step 3: Advance the schedule

`team_wait` is **blocking**: internally it ticks (reconcile + dispatch) every few seconds
and only returns when **a member finishes**, **the whole team completes**, or its
**timeout** elapses. So call it **once and wait** — do NOT write your own loop that fires
`team_wait` back-to-back; that just floods the context with identical calls.

- `team_wait` — blocks, auto-advancing the schedule (completes finished members → unblocks
  and starts dependents up to the parallel budget). Returns a `reason`
  (`complete` / `progress` / `timeout`) plus `justCompleted` / `justStarted` and the full
  status snapshot. `timeoutSec` (default 600) caps how long one call blocks.
- `team_status` — read-only snapshot any time you want a progress check without advancing.

Pattern: call `team_wait`; when it returns, if `complete=false` call `team_wait` **once
more**; repeat. That is ~one call per member completion, not per second. A failed/crashed
member returns its module task to `pending` and the next `team_wait` retries it; if it keeps
failing, inspect that module's changes and fix it yourself.

## Human visibility (automatic — no command needed)

The human watching the OpenCode TUI sees team progress **live, without you doing
anything**:

- **Toasts** pop automatically when a member finishes (`✓ module 完成`), a member fails
  (`✗ …`), or the whole team completes (`🎉 …`). These come from the team plugin itself.
- **Sidebar widget** — a persistent `xflow team` panel in the session sidebar shows the
  aggregate counts and a per-module progress bar, refreshing every couple of seconds from
  disk truth.

So you do **not** need to call `team_status` just to keep the human informed — they
already see it. Use `team_status` / `team_wait` output for **your own** scheduling
decisions, and summarize only meaningful milestones in chat.

## Step 4: Integrate and clean up

Each member only **implements** its module — members do **not** archive. Once the
team is complete:

1. Review the changes produced by each member in the shared repo root.
2. Call `team_delete` to cancel any leftover member processes and clean up the team's
   runtime state.
3. Proceed to `/xf:archive` as usual once all modules are done.

## Guardrails

- One member per module — never two members on the same module (enforced as a module mutex).
- Do not hand-roll `opencode run` for members; use `team_create` so slots, heartbeats,
  stale reclaim and dependency gating are handled for you.
- Members run to completion in the background; the lead never blocks — it ticks with
  `team_wait`. Do not busy-wait.
