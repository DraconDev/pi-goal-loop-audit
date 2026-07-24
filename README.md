# pi-goal-list-loop-audit

> **Goal. Loop. Audit. Done.**

A pi-coding-agent extension that supervises long-running work to verified completion. The plugin writes a durable goal to disk, drives the agent through an `agent_end`-driven loop, and on each `complete_goal` — spawns an **isolated auditor in a fresh pi session** to verify the work is genuinely done.

The auditor runs in a fresh session with no extensions, no skills, no prompts, no editor. It has only `read` / `grep` / `find` / `ls` / `bash`. It cannot see the implementing conversation. It cannot plant evidence. The implementer cannot fool it.

## Why this exists

Most pi goal extensions — `pi-goal`, `pi-goal-x`, `pi-loop-mode`, `ralphi`, `tmustier-pi-ralph-wiggum` — let the same agent that did the work also be the verifier. **That's the bamboozle trap.** The agent that wrote the implementation also says "I'm done", and the loop trusts them.

`pi-goal-list-loop-audit` separates **implementation** from **verification**. Two independent sessions, two independent read paths, two perspectives.

### Architectural guarantee

| Stage | Protection |
|---|---|
| Goal intake | Drafting + Confirm/Reject dialog; nothing activates unconfirmed |
| Implementation | `agent_end`-driven continuation loop with 5-minute hard backoff cap |
| Completion | Isolated auditor session + **regression_shield**: raw command output required per verification-contract item, enforced orchestrator-side |

## Quick start

Install:
```bash
pi install npm:pi-goal-list-loop-audit
```

Four top-level commands, that's all:

```
/goal                              # drafting: agent grills, you Confirm
/goal "audit the repo"             # no contract clause → agent grills you first (propose is gated on it)
/goal "Step 1. Step 2. Done when: tests pass."   # has contract → starts now
/goal start "fix the flaky login test"          # explicit skip-draft: starts now, no interview (auditor infers the contract)
/goal status                       # show state
/goal pause                        # pause
/goal resume                       # resume
/goal cancel                       # abort
/goal tweak "<new objective>"      # edit in place (Confirm dialog)
/goal archive                      # archived goals, newest first
/glla                               # open the settings UI (or /glla key=value)
/list fix the login bug, add dark mode, write docs   # dump it — the agent shapes it into items, one Confirm
/list plan.md                      # file detected → bulk import, one Confirm (sisyphus/Ralph style)
/list <paste a checklist>          # multi-line paste → same batch flow
/list "fix the flaky test. Done when: npm test green"   # explicit contract → added directly, no interview
/list                              # show the list (add/import are optional no-op aliases — detection routes everything)

(Or just say it: "queue these 10 things…" — the agent manages the list too.)

**Order is the default, not the law**: auto-advance takes the head (FIFO), but
`/list next <n>` or the agent's `list_activate` tool picks any item — with
subagents, what gets worked next is a choice, not a position. Numbering always
matches `/list show`.
/list                              # show active + waiting items
/list next                         # skip current, activate next
/list remove <n>                   # drop item n from the list
/list clear                        # empty the list
/list cancel                       # stop the whole list: abort the active item + drop all waiting
/loop                              # draft the loop (agent grills; measure is test-run before you confirm)
/loop start "keep polishing the UI"                          # infinite metricless loop (v0.23.6): no plateau, no cap — ends at time=/tokens= or /loop stop
/loop respec                                                  # infinite metricless loop reconciling the codebase against the root SPEC.md / spec.md (v0.24.3) — 2 specs = you pick, 0 specs = drafting, 1 spec = auto-start (v0.24.4)
/loop start "reduce TODOs" measure="grep -c TODO src.txt | head -1" direction=min
/loop start "shrink the bundle" measure="..." direction=min time=4 tokens=500000   # arbitrary bounds
/loop start "reduce TODOs" measure="..." direction=min branch=1   # scratch-branch mode
/loop start "keep improving SPEC.md" measure=none max=20   # metricless with an explicit cap (v0.23.0)
/loop status                       # iteration, best, stall, recent values
/loop stop                         # halt with summary
```

**Metricless loops** (`measure=none`): for genuinely endless work — an
ever-improving spec, continuous hardening — where no number means "better".
There is **no plateau stop** (nothing to stall on): the loop ends only at
its bounds (`max` iterations — `max=0` is truly unbounded — `time` hours,
`tokens` budget) or `/loop stop`. Every iteration must make one real,
inspectable change; cosmetic churn is the known failure mode
(doorknob-polishing). The drafter offers this when you say there is no
number, and tells you the trade-off before you confirm. Work with a finish
line is still a `/goal`.

**Anti-repetition** (v0.24.0, both loop flavors): the plateau stop watches
the *number*; the stuck ladder watches the *work*. Every iteration is
classified — exact/near-duplicate replies, A-B-A-B alternation, same
tool-same-result three times, narration-only streaks, degenerate
single-reply repetition — and a stuck iteration swaps the next prompt for
a rotating intervention (different approach → different subtask →
PROGRESS.md → fix one test failure → review your own diff). Three stuck in
a row escalates to a hard reset (banned openings, tool-call-first); five
stops the loop with the reason — bounded and surfaced, like plateau.
Continuation lines also rotate: identical prompts invite identical answers.

Subcommands match **exactly** — `/goal pause the pipeline` sets an objective
about a pipeline; only bare `/goal pause` pauses. (Same rule everywhere, so
your objectives can start with any verb.)

Drafting rules: **no-args drafts, args-without-a-`Done when:`-clause get
grilled by the agent (proposing is mechanically blocked until you have
replied at least once — typed chat or an answered `ask_user_question` dialog
both count), args-with-a-clause start instantly, `/goal start` skips the
interview by explicit command, a file path is
bulk direct.** A
sisyphus-style plan file (checklists, bullets, numbered, plain lines) imports
as-is — headings become nothing, items become goals. And the drafter itself
batches: asking for "these 50 tasks" in a `/list` drafting session produces
ONE confirmed batch, not 50 dialogs.
Note: every list item is audited individually, so at hundreds of items the
audit cost per item is the thing to think about.

**Drafting is the default for long-running things.** `/goal` and
`/loop` with no arguments — and any vague `/list` dump — all start a
grilling turn that ends in a Confirm dialog. For `/loop` specifically, the orchestrator **test-runs the proposed
measure command once** and shows the real number in the dialog — you validate
the metric before a single iteration burns tokens.

With `branch=1`, all work lands on a scratch branch (`pi-glla-loop/<ts>-<slug>`):
improvements are committed, regressions are hard-reset (scratch branch only),
and on stop you return to your original branch with merge instructions.
Requires a clean working tree.

Loop 3 is metric-driven: the **orchestrator** runs your `measure` command after
every agent turn. The agent never self-reports progress — the loop only
believes a number. There is no auditor in loop 3; the metric is the verdict.

**A loop never completes.** Goal = achievement, loop = process: there is no
`done=` (v0.15.0 removed it — "improve until X" is a `/goal`). A loop runs
until `/loop stop`, plateau (`window=5` non-improving iterations — the well is
dry, not "done"), `max=` iterations, or the arbitrary bounds `time=<hours>` /
`tokens=<budget>`. And the spec is **alive**: mid-loop the agent can call
`propose_loop_refine` to sharpen the target or swap the measure — you confirm,
the orchestrator test-runs and re-baselines, and both eras stay in history.

## Which loop? (the decision rule)

**`/goal`** — one thing, judged *semantically*. Research, features, docs,
anything where "done" needs a reader. The isolated auditor verifies against
your `Done when:` contract with quoted evidence.

**`/list`** — many things, judged the same way, in turn. Bulk-import a plan
or just say "queue these 10 things". Order is the default, not the law:
`/list next <n>` picks any item.

**`/loop`** — one thing, judged *numerically*, as a **process that never
completes**. ONLY when a shell command can print a number that honestly
tracks progress: test failures, TODO count, bundle size, coverage %, lint
warnings, build time, dep count. The metric IS the auditor here — there is
no semantic judge, so a fake metric (word count, file exists) is worse than
no loop. There is no finish line (`done=` was removed in v0.15.0 — "improve
until X" is a `/goal`); the loop runs until you stop it, the metric plateaus,
or a time/token bound trips. `/loop` with no args drafts one for you:
the agent proposes a measure, the orchestrator **test-runs it and shows you
the real number** before you confirm; if no honest metric exists it will
redirect you to `/goal`.

## Three loops on one state machine

| Loop | Command | Status |
|---|---|---|
| 1. Single ordered goal | `/goal "<objective>"` | **shipped v0.1.0** |
| 2. List of goals (a pool, not a FIFO) | `/list [show\|next\|remove\|clear]` | **shipped v0.2.0** |
| 3. Metric-driven process loop | `/loop start\|status\|stop` | **shipped v0.3.0** |

Each loop is a different policy class on the same status machine.

## What this fixes vs. pi-goal-x

| Flaw in pi-goal-x | Fix in pi-goal-list-loop-audit |
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

A persistent `glla:` status segment + an above-editor widget show the current
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
/glla                                # open the settings UI
/glla model=provider/id              # auditor model override → GLOBAL
/glla thinking=high                  # auditor thinking → GLOBAL
/glla notify='cmd "$1"'              # push on complete/pause/stop → GLOBAL
/glla tokenlimit=10000000            # per-goal token budget (default: off) → GLOBAL
/glla tokenlimit=0                   # explicitly no cap (the default)
/glla wedgealert=30                  # hung-command alert minutes (default: 30, 0 = off)
/glla autoresume=on                  # held goals/loops auto-resume in fresh sessions (unattended rigs)
/glla auditcap=5                     # pause the goal after N consecutive auditor disapprovals (default 3, 0 = unlimited)
/glla auditfeedbackchars=16000       # auditor report returned to the executor (default 800, 0 = full report)
/glla autoaccept=on                  # drafts ACTIVATE without the Confirm dialog (unattended rigs)
/glla project tokenlimit=500         # rare per-project override
```

Resolution per key: **project > global > defaults**. The auditor defaults to
your pi session model. When the session provider is extension-registered the
auditor can't auth it — you're told once (info level) with the fix:
`/glla model=provider/id`, set once, rarely touched again. The plugin never
picks a model itself. Thinking follows the session too (floor `high`).

On disapproval, the executor receives up to `auditFeedbackChars` characters
from the auditor report (default 800, preserving the previous behavior).
Increase it for multi-item `<evidence>` blocks and raw verification output,
or set `/glla auditfeedbackchars=0` to return the full report. The complete
report continues to be stored in audit history and is available through
`/goal status`.

`autoaccept=on` skips BOTH the Confirm dialog and the drafting interview
floor — every `propose_*` draft (goal, list batch, loop, task list)
activates the moment the agent proposes it, with a notification and a
`draft_autoaccepted` ledger entry (auto-accept is never silent). The seed
carries the intent. Pair with `autoresume=on` for fully unattended rigs.

## Subagents (`@tintinweb/pi-subagents`)

Subagent sessions bind extensions too, so glla loads there — by design the
**main session owns the goal/loop/list; subagents are workers** (v0.23.8):

- Read-only agents (Explore, Plan) get no glla tools (pi-subagents gates
  them); general-purpose agents see them but state-mutating calls
  (`complete_goal`, `propose_*`, `list_add`, `pause_goal`, …) are refused
  with "report back to the main agent".
- A subagent session never clobbers the loop's session handle, never runs
  the restore gate, and never drives continuation — so the heartbeat,
  wedge alert, and auto-resume machinery always act on the main session.
  (pi hands a fresh ctx wrapper per event; `ctx.sessionManager` identity
  is the discriminator.)
- Subagent tool activity counts as activity for the wedge clock — a long
  subagent run is work, not a hang.

## Token guard

Every goal tracks real token usage; crossing the budget pauses the goal.
Off by default (opt-in) — set a budget with `/glla tokenlimit=<n>`. A high
value like 10000000 is a runaway threshold, not a big-goal threshold
(real research/feature goals legitimately burn 2-4M). Loop 3 doesn't need
this cap — it has its own brakes
(max iterations + plateau).

## Wedge alert

The turn-based watchdogs can't see one failure shape: the session is busy
but silent for a long stretch because ONE unbounded command (a test suite
that never exits, a dev server) is holding the whole goal hostage. The
heartbeat watches the wall clock: busy + no activity for 30 minutes →
in-session warning + your configured notify push, once per interval while
it persists. Tune with `/glla wedgealert=<minutes>` (0 = off).

Every other wait is bounded too: continuation retries are milliseconds,
stuck backoff caps at 5 minutes then pauses, measure commands get a 10m
hard timeout, and the auditor aborts after 10m with zero session activity
(infrastructure error, never a verdict).

## Compatibility (what goes well, what conflicts)

**The Two-Driver Rule**: any plugin that drives agent turns on `agent_end`
conflicts — two supervisors scheduling continuations into one session produce
contradictory turns. One driver at a time:

- **Hard conflicts** (do not install together): `pi-codex-goal`, `pi-loop-mode`,
  `pi-goal-x`, `pi-goal*`, `ralphi`, `pi-ralph*`, `pi-autoresearch` (active).
- **Overlap**: `@badliveware/pi-compaction-continue` — our heartbeat covers
  stalls while a goal/list/loop is active; both installed may double-nudge.
- **Installed-but-don't-run-simultaneously**: `@tmustier/pi-ralph-wiggum` —
  fine to keep, never run a ralph loop while a goal/list/loop is active.

**Goes well with it**: `@juicesharp/rpiv-ask-user-question` (drafting uses its
structured forms), `@tintinweb/pi-subagents` (spawn research/review subagents
inside goal work), `@tintinweb/pi-tasks` (session-wide DAGs vs our goal-scoped
task lists — different granularity), `pi-chrome` (the research/search path for
goals — logged-in browsing with no extra services; standalone search skills
like `mmx-cli`/`pi-search-skill` are optional conveniences for bulk queries,
not requirements).

**Two footnotes**: (1) extension-registered providers work in the main session
but not the auditor's extension-less session — if audits fail auth, set the
override once with `/glla model=`. (2) `pi-notify-agent` notifies on every turn;
`/glla notify=` fires only on goal complete/pause/loop stop.

## Files

```
extensions/
  loops/goal.ts                # /goal + /list commands, agent tools, loop driver
  goal-loop-core.ts            # types, JSONL state, pure helpers
  goal-loop-auditor.ts         # isolated auditor (fresh session, no extensions)
  goal-loop-shield.ts          # regression_shield (pure, dependency-free)
  goal-loop-display.ts         # status line + /goal status rendering
  goal-loop-forever.ts         # /loop measure/parse/plateau helpers
  goal-loop-backoff.ts         # 5-min hard cap
prompts/
  goal-loop-continuation.md    # loop driver prompt
  goal-loop-draft.md           # drafting prompt
  goal-loop-forever.md         # /loop driver prompt
  goal-loop-forever-draft.md   # /loop drafting prompt
scripts/
  smoke.sh                     # live integration harness (tmux + real models)
tests/                         # 168 unit tests, no live pi required
docs/DESIGN.md                 # architectural decisions
PLAN.md                        # milestones, decisions, gates
```

## Detailed design

See `docs/DESIGN.md`. Milestones and decisions live in `PLAN.md`.

## Installation from source

```bash
git clone https://github.com/DraconDev/pi-goal-list-loop-audit.git
cd pi-goal-list-loop-audit
pi install .
```

## License

MIT
