# pi-goal-loop-audit — design

This is the v0.1.0 design document. It records the architectural choices and why.

## Scope of v0.1.0

Single loop only — **loop 1**, the single ordered goal.

| Loop | Status |
|---|---|
| Loop 1 (single ordered goal with auditor) | **v0.1.0** |
| Loop 2 (list — many goals in a queue) | v0.2.0 |
| Loop 3 (loop — forever polish) | v0.3.0 |

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
- Three packages: `pi-goal-loop-audit`, `pi-goal-loop-audit-list`, `pi-goal-loop-audit-loop`.
- One package with three subcommands: `/goal`, `/pi-gla-list`, `/pi-gla-loop`.

We choose **one package with subcommands**. Reasoning:
- Single install (`pi install npm:pi-goal-loop-audit`).
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

### Decision 7: Per-loop file split

| File | Purpose | Lines |
|---|---|---|
| `extensions/loops/goal.ts` | Loop 1 (single ordered goal) — this release | ~400 |
| `extensions/loop2-list.ts` | Loop 2 (queue of goals) | v0.2.0 |
| `extensions/loop3-loop.ts` | Loop 3 (forever polish) | v0.3.0 |
| `extensions/goal-loop-core.ts` | Shared state machine, types, JSONL | ~150 |
| `extensions/goal-loop-auditor.ts` | Isolated auditor with regression_shield | ~300 |
| `extensions/goal-loop-backoff.ts` | Hard 5-minute cap | ~80 |
| `extensions/goal-loop-draft.ts` | Drafting phase with structured Q&A | v0.2.0 |
| `extensions/goal-loop-renderer.ts` | Native markdown widget | ~120 |
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

Goal state lives in `.pi-gla/active.jsonl`. Each line is a state transition. On compaction, the summary is rebuilt deterministically from the JSONL (autoresearch pattern).

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
