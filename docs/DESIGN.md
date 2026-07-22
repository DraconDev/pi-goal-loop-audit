# pi-goal-list-loop-audit — design

This document records the architectural choices and why. v0.1.0 decisions are
below; later releases append addenda rather than rewrite history.

## Scope

| Loop | Status |
|---|---|
| Loop 1 (single ordered goal with auditor) | **shipped v0.1.0** |
| Loop 2 (list — many goals in a queue) | **shipped v0.2.0** |
| Loop 3 (loop — metric-driven forever) | **shipped v0.3.0** |
| Completion release (compaction, token guard, branch mode) | **shipped v0.4.0** |

## Addendum v0.2.0 (list + shield + drafting)

- **`/list` queue**: items are full goals (objective + contract). The active
  goal and the queue share one `State`; `setGoal`/`archiveCurrentGoal`
  preserve `state.list` explicitly (an early draft wiped it). Completing a
  list-sourced goal auto-activates the next item (v0.10.0: aborts no longer
  auto-advance — `/list next` and `list_activate` pick explicitly).
- **regression_shield**: the auditor's report must contain an `<evidence>`
  block quoting raw tool output per verification-contract item. Enforcement is
  **orchestrator-side** (`goal-loop-shield.ts`, pure): an `<approved/>`
  without complete evidence becomes a disapproval. This closes the
  "`bash true` rubber-stamp" hole pi-goal-x documented as accepted-risk.
- **Drafting**: `/goal` with no args sends a drafting prompt; the agent
  clarifies, then `propose_goal_draft` opens a real Confirm dialog. Direct
  activation stays available via `/goal "<objective>"`.
- **Inline contract extraction**: one-liner objectives
  (`Create x. Done when: grep -q ok x`) extract the contract — the
  line-start-only extractor silently disarmed the shield on every one-liner.

## Addendum v0.3.0 (metric loop + tasks + notify)

- **Loop 3 is metric-driven, not vibes-driven** (the anti-doorknob law: the
  loop only believes a number). The **orchestrator** runs the user's `measure`
  command after every `agent_end`; the agent never self-reports. Termination:
  plateau (`window` stalls), iteration cap, `/loop stop`. No auditor in
  loop 3 — the metric is the verdict. No git auto-revert: on regression the
  agent is told to undo its own change (safe with uncommitted user work).
- **`propose_task_list`** with anti-drift caps (20 tasks / 5 subtasks) —
  pi-goal-x flaw #4. Confirm dialog before the list is set.
- **`notify=<cmd>`**: fire-and-forget shell-out on goal complete / goal pause /
  loop stop, message as `$1`. Settings parser is quote-aware.

## Addendum v0.4.0 (completion)

- **Auditor compaction enabled** (flaw #3 — the last open one). Safety:
  the shield is orchestrator-side, so compaction can only weaken the
  auditor's evidence → disapproval, never a false approval.
- **Token guard**: real accumulation from assistant-message `usage.totalTokens`
  (deduped across replayed `agent_end` history). Crossing `tokenlimit`
  (default 1M) pauses the goal with a clear reason.
- **Loop 3 `branch=1`**: scratch branch `pi-gla-loop/<ts>-<slug>`; commit per
  improvement, `git reset --hard` per regression — scratch branch only.
  Refuses non-git dirs and dirty trees; returns to the original branch on
  stop with merge instructions.
- **Resumption notice** on `session_start` (replaces the impossible
  "plugin vanished" self-check: absent code cannot run).

## Scope of v0.1.0 (original)

Single loop only — **loop 1**, the single ordered goal.

**Why ship loop 1 first**: the user asked for it, it's the highest-value loop, and getting the auditor + drafting right matters more than breadth.

## Architectural decisions

### Decision 1: Anti-bamboozle via isolated auditor

The single most important property of this plugin is that the implementing agent cannot bamboozle the verifier. The way to achieve this structurally:

1. The auditor runs in a **fresh pi agent session**.
2. The auditor has **no extensions, no skills, no prompts, no themes**.
3. The auditor has only **read-only tools**: `read`, `grep`, `find`, `ls`, `bash` (and `bash` is for re-running user's verifier scripts, not arbitrary).
4. The auditor **cannot see the implementing conversation**.

This is borrowed directly from `pi-goal-x/extensions/goal-auditor.ts:148-156`. The pattern is sound; we don't improve on it in v0.1.0, we just **fork the proven source and add regression_shield**.

### Decision 2: regression_shield in v0.2.0

v0.1.0 ships the same auditor behaviour as pi-goal-x. The author of pi-goal-x documented an honest caveat (verbatim):

> "the guarantee is deliberately just 'the auditor ran at least one successful tool', not 'it inspected the right content': there is no cheap, honest way to tell a requirement-relevant `read` from `bash true`, an empty `grep`, or a read of an executor-planted file."

We accept this caveat for v0.1.0. v0.2.0 will add **regression_shield**: an explicit requirement that the auditor's report must include raw output (a `cat`, a `grep -A 5 <file>`, a `bash <user-script>`) for every item in `verificationContract`. Without that evidence, the auditor's `<approved/>` is rejected by the orchestrator.

### Decision 3: Hard 5-minute backoff cap

The #1 complaint about pi-goal-x in our audit (user-stated) was "1-hour waits". The cause is exponential backoff with no ceiling.

v0.1.0 ships a hard 5-minute cap. After 5 minutes of consecutive backoff:
1. TUI badge turns red with "Last activity: 5m+".
2. User can press `r` to force-continue or `s` to skip to next pending task.
3. Optional: configure Telegram/web push notification.

### Decision 4: No drafting phase in v0.1.0 (deferred to v0.2.0)

The user identified vague-correction as a key strength of pi-goal-x. But shipping it in v0.1.0 doubles the scope and we won't get the auditor right if we split focus.

v0.1.0 ships `/goal "<objective>"` only — same UX as pi-goal-x's `/goal-set`. v0.2.0 adds the drafting protocol with structured `goal_questionnaire` widget.

This is a deliberate trade-off. If the user wants drafting in v0.1.0, say so and I'll prioritise.

### Decision 5: One package per loop (not three packages)

Some alternatives considered:
- Three packages: `pi-goal-list-loop-audit`, `pi-goal-list-loop-audit-list`, `pi-goal-list-loop-audit-loop`.
- One package with three subcommands: `/goal`, `/pi-gla-list`, `/pi-gla-loop`.

We choose **one package with subcommands**. Reasoning:
- Single install (`pi install npm:pi-goal-list-loop-audit`).
- All three loops share state machine, schemas, scaffolding.
- v0.1.0 only ships loop 1, but the package already declares loop 2 and loop 3 as `pi.commands` so users see what is coming.

### Decision 6: Forks pi-goal-x rather than reimplements

Why not write from scratch?
- The auditor pattern is sound and small (one function: `runGoalCompletionAuditor`).
- The drafting phase logic is sound and small.
- The continuation loop is sound and small.
- The compaction discipline is battle-tested.

We fork pi-goal-x 0.19.0 source. We then **simplify by removing the broken parts** (markdown summaries, unbounded backoff) and **clean the seams** (split the single `goal.ts` file into per-loop files).

This is a **clean break** by decision of the user. We do not interop with `pi-goal-x`'s `.pi/goals/` directory.

### Decision 7: Per-loop file split (superseded)

> **Superseded by consolidation (v0.8.0).** The planned per-loop files below
> never shipped: loops 1+2 live together in `extensions/loops/goal.ts`
> (one state machine, one loop driver), loop 3's helpers in
> `extensions/loops/forever.ts`, rendering in `goal-loop-display.ts`,
> drafting inline in `goal.ts` + `prompts/`. Kept for history.

| File | Purpose | Lines |
|---|---|---|
| `extensions/loops/goal.ts` | Loops 1+2 (single goal + list of goals) | shipped |
| `extensions/loops/forever.ts` | Loop 3 (metric loop helpers) | shipped |
| `extensions/goal-loop-core.ts` | Shared state machine, types, JSONL | shipped |
| `extensions/goal-loop-auditor.ts` | Isolated auditor with regression_shield | shipped |
| `extensions/goal-loop-display.ts` | Status line + /goal status rendering | shipped |
| `prompts/goal-loop-continuation.md` | Templated continuation prompt | ~80 |
| `prompts/goal-loop-auditor.md` | Templated auditor prompt | ~80 |
| `prompts/goal-loop-draft.md` | Templated drafting prompt | v0.2.0 |
| `schemas/goal.schema.json` | JSON Schema for goal state | ~50 |

### Decision 8: Status machine

```ts
type Status =
  | "drafting"        // v0.2.0
  | "active"
  | "auditing"
  | "complete"
  | "paused"
  | "aborted";
```

States owned by the orchestrator:
- `active` → next iteration
- `auditing` → auditor running
- `complete` → archived
- `paused` → user-resumable
- `aborted` → user-cancelled

Transitions:
```
drafting → active          (user confirms draft)
active → active            (continue work)
active → auditing          (complete_goal called)
auditing → complete        (auditor <approved/>)
auditing → active          (auditor <disapproved/>; reset iteration counter)
active → paused            (pause_goal called, or stuck > 5 min, or empty turn)
paused → active            (user /pi-gla-resume)
active → aborted           (user /pi-gla-cancel)
```

### Decision 9: JSONL state (deterministic compaction)

Goal state lives in `.pi-glla/active.jsonl`. Each line is a state transition. On compaction, the summary is rebuilt deterministically from the JSONL (autoresearch pattern).

This protects against model-generated summaries losing fidelity.

### Decision 10: Hard pause + escape hatches

| Trigger | Action |
|---|---|
| `Esc` during auditor | Pause; user picks "complete without audit" or "continue" |
| `Esc` during agent turn | Pause |
| User `/pi-gla-pause` | Pause |
| User `/pi-gla-cancel` | Abort (wipes active goal) |
| Stuck > 5 min | Pause + notify |
| Empty turn (no tool calls) | Pause (no momentum) |

## Open follow-ups (post-v0.1.0)

| Priority | Item | When |
|---|---|---|
| HIGH | Drafting phase with structured Q&A | v0.2.0 |
| HIGH | regression_shield for auditor | v0.2.0 |
| MEDIUM | Native TUI form widget | v0.2.0 |
| MEDIUM | Loop 2 (list) | v0.2.0 |
| MEDIUM | Loop 3 (loop) | v0.3.0 |
| LOW | Telegram push | v0.3.0 |
| LOW | Sub-task auto-close | v0.3.0 |

## Files

- `docs/DESIGN.md` — **this file**
- `README.md` — quickstart
- `audit/pi-name-v3-registry-based.md` — naming rationale
- `audit/pi-goal-loop-design.md` — earlier design (now superseded)
