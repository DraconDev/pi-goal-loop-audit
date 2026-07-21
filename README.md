# pi-goal-loop-audit

> **Goal. Loop. Audit. Done.**

A pi-coding-agent extension that supervises long-running work to verified completion. The plugin writes a durable goal to disk, drives the agent through an `agent_end`-driven loop, and on each `complete_goal` — spawns an **isolated auditor in a fresh pi session** to verify the work is genuinely done.

The auditor runs in a fresh session with no extensions, no skills, no prompts, no editor. It has only `read` / `grep` / `find` / `ls` / `bash`. It cannot see the implementing conversation. It cannot plant evidence. The implementer cannot fool it.

## Why this exists

Most pi goal extensions — `pi-goal`, `pi-goal-x`, `pi-loop-mode`, `ralphi`, `tmustier-pi-ralph-wiggum` — let the same agent that did the work also be the verifier. **That's the bamboozle trap.** The agent that wrote the implementation also says "I'm done", and the loop trusts them.

`pi-goal-loop-audit` separates **implementation** from **verification**. Two independent sessions, two independent read paths, two perspectives.

### Architectural guarantee

| Stage | Protection |
|---|---|
| Goal intake | Drafting + Confirm/Reject dialog; nothing activates unconfirmed |
| Implementation | `agent_end`-driven continuation loop with 5-minute hard backoff cap |
| Completion | Isolated auditor session + **regression_shield**: raw command output required per verification-contract item, enforced orchestrator-side |

## Quick start

Install:
```bash
pi install npm:pi-goal-loop-audit
```

Four top-level commands, that's all:

```
/goal                              # drafting: agent grills, you Confirm
/goal "Step 1. Step 2. Done when: tests pass."   # set + start now
/goal status                       # show state
/goal pause                        # pause
/goal resume                       # resume
/goal cancel                       # abort
/goal tweak "<new objective>"      # edit in place (Confirm dialog)
/goal archive                      # archived goals, newest first
/gla                               # open the settings UI (or /gla key=value)
/queue add                          # draft a contract (or a whole batch via items[])
/queue add "<objective>"            # queue one directly
/queue add plan.md                  # file detected → bulk import, one Confirm
/queue add <paste a checklist>      # multi-line paste → same batch flow

(Or just say it: "queue these 10 things…" — the agent manages the list too.)
/list                              # show active + queue
/queue next                         # skip current, activate next
/queue remove <n>                   # drop item n from the queue
/queue clear                        # empty the queue
/loop                              # draft the loop (agent grills; measure is test-run before you confirm)
/loop start "reduce TODOs" measure="grep -c TODO src.txt | head -1" direction=min done=0
/loop start "reduce TODOs" measure="..." direction=min branch=1   # scratch-branch mode
/loop status                       # iteration, best, stall, recent values
/loop stop                         # halt with summary
```

Subcommands match **exactly** — `/goal pause the pipeline` sets an objective
about a pipeline; only bare `/goal pause` pauses. (Same rule everywhere, so
your objectives can start with any verb.)

Drafting rules: **no-args drafts, with-args is direct, a file path is bulk
direct.** A sisyphus-style plan file (checklists, bullets, numbered, plain
lines) imports as-is — headings become nothing, items become goals. And the
drafter itself batches: asking for "these 50 tasks" in a `/list` drafting
session produces ONE confirmed batch, not 50 dialogs.
Note: every queue item is audited individually, so at hundreds of items the
audit cost per item is the thing to think about.

**Drafting is the default for long-running things.** `/goal`, `/queue add`, and
`/loop` with no arguments all start a grilling turn that ends in a Confirm
dialog. For `/loop` specifically, the orchestrator **test-runs the proposed
measure command once** and shows the real number in the dialog — you validate
the metric before a single iteration burns tokens.

With `branch=1`, all work lands on a scratch branch (`pi-gla-loop/<ts>-<slug>`):
improvements are committed, regressions are hard-reset (scratch branch only),
and on stop you return to your original branch with merge instructions.
Requires a clean working tree.

Loop 3 is metric-driven: the **orchestrator** runs your `measure` command after
every agent turn and stops on plateau (`window=5` non-improving iterations by
default), iteration cap (`max=50`), or `/loop stop`. The agent never self-reports
progress — the loop only believes a number. There is no auditor in loop 3; the
metric is the verdict.

## Three loops on one state machine

| Loop | Command | Status |
|---|---|---|
| 1. Single ordered goal | `/goal "<objective>"` | **shipped v0.1.0** |
| 2. Queue of goals | `/queue add\|show\|next\|remove\|clear` | **shipped v0.2.0** |
| 3. Forever-polish loop | `/loop start\|status\|stop` | **shipped v0.3.0** |

Each loop is a different policy class on the same status machine.

## What this fixes vs. pi-goal-x

| Flaw in pi-goal-x | Fix in pi-goal-loop-audit |
|---|---|
| `detailedSummary` is hand-concat strings | Structured JSON state + native markdown renderer |
| Stuck-counter has no ceiling — 1-hour waits happen | Hard 5-minute backoff cap, fall through to user notification |
| Auditor can rubber-stamp after `bash true` | **regression_shield** (shipped v0.2.0): auditor must quote raw tool output per verification-contract item; orchestrator rejects evidence-free approvals |
| `pause_goal` is fire-and-forget | Clear `pauseReason` surfaced in status + agent feedback |
| Vague objective + weak auditor = rubber-stamp | Drafting phase with Confirm dialog + isolated auditor + shield |
| Esc mid-audit just dies | Escape dialog: complete-without-audit / continue (shipped v0.2.0) |
| Auditor can't compact — context exhaustion mid-audit | Compaction enabled (v0.4.0); safe because the shield is orchestrator-side |
| Agent can grow subtasks indefinitely | `propose_task_list` with 20/5 caps + Confirm dialog (v0.3.0) |

## Live TUI (always know it's on)

A persistent `gla:` status segment + an above-editor widget show the current
goal/loop at all times: objective, status, elapsed, tokens, next task or loop
metric, pause reason, and live auditor progress during audits. If something is
running, you can see it — no command needed.

## Self-watchdog (liveness is built in)

A 15s heartbeat detects the precise stall condition — active goal/loop + idle
session + nothing scheduled + quiet for 60s — and re-fires the continuation
itself. Three consecutive zero-tool turns pause the goal / stop the loop.
No external watchdog plugin needed.

## Config (one global place, rarely opened)

```
/gla                                # open the settings UI
/gla model=provider/id              # auditor model override → GLOBAL
/gla thinking=high                  # auditor thinking → GLOBAL
/gla notify='cmd "$1"'              # push on complete/pause/stop → GLOBAL
/gla tokenlimit=2000000             # per-goal token budget → GLOBAL
/gla project tokenlimit=500         # rare per-project override
```

Resolution per key: **project > global > defaults**. The auditor defaults to
your pi session model (auto-fallback to a credentialed built-in, named once at
info level, when the session provider is extension-registered); thinking
follows the session too (floor `high`).

## Token guard

Every goal tracks real token usage; crossing the budget pauses the goal.
Default 1,000,000 per goal — tune with `/gla tokenlimit=<n>`.

## Compatibility (what goes well, what conflicts)

**The Two-Driver Rule**: any plugin that drives agent turns on `agent_end`
conflicts — two supervisors scheduling continuations into one session produce
contradictory turns. One driver at a time:

- **Hard conflicts** (do not install together): `pi-codex-goal`, `pi-loop-mode`,
  `pi-goal-x`, `pi-goal*`, `ralphi`, `pi-ralph*`, `pi-autoresearch` (active).
- **Overlap**: `@badliveware/pi-compaction-continue` — our heartbeat covers
  stalls while a goal/queue/loop is active; both installed may double-nudge.
- **Installed-but-don't-run-simultaneously**: `@tmustier/pi-ralph-wiggum` —
  fine to keep, never run a ralph loop while a goal/queue/loop is active.

**Goes well with it**: `@juicesharp/rpiv-ask-user-question` (drafting uses its
structured forms), `@tintinweb/pi-subagents` (spawn research/review subagents
inside goal work), `@tintinweb/pi-tasks` (session-wide DAGs vs our goal-scoped
task lists — different granularity), `pi-chrome` (browser for research goals),
search skills (`mmx-cli`, `pi-search-skill`).

**Two footnotes**: (1) extension-registered providers work in the main session
but not the auditor's extension-less session — the auto-fallback names a pick,
`/gla model=` pins it. (2) `pi-notify-agent` notifies on every turn;
`/gla notify=` fires only on goal complete/pause/loop stop.

## Files

```
extensions/
  loops/goal.ts                # /goal + /list commands, agent tools, loop driver
  goal-loop-core.ts            # types, JSONL state, renderer
  goal-loop-auditor.ts         # isolated auditor (fresh session, no extensions)
  goal-loop-shield.ts          # regression_shield (pure, dependency-free)
  goal-loop-backoff.ts         # 5-min hard cap
prompts/
  goal-loop-continuation.md    # loop driver prompt
  goal-loop-draft.md           # drafting prompt
scripts/
  smoke.sh                     # live integration harness (tmux + real models)
tests/                         # 43 unit tests, no live pi required
docs/DESIGN.md                 # architectural decisions
PLAN.md                        # milestones, decisions, gates
```

## Detailed design

See `docs/DESIGN.md`. Milestones and decisions live in `PLAN.md`.

## Installation from source

```bash
git clone https://github.com/DraconDev/pi-goal-loop-audit.git
cd pi-goal-loop-audit
pi install .
```

## License

MIT