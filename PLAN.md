# PLAN — pi-goal-loop-audit

Living plan for the project. Update this file as decisions land or milestones close.
Last updated: v0.1.0-alpha.1 scaffold.

---

## 0. Product definition (frozen)

- **What it is**: a pi-coding-agent extension that supervises long-running work to *verified* completion.
- **Core mechanism**: a shared goal state machine + an `agent_end`-driven continuation loop + an **isolated auditor** (fresh pi session, no extensions, no skills, read-only tools) that must approve before a goal is marked complete.
- **Three loops on one machine**:
  - **goal** — one ordered goal, audited (`/goal`)
  - **list** — a queue of goals, each audited in turn (`/list`)
  - **loop** — a forever-polish loop around a measurable target (`/loop`)
- **Naming is frozen**: commands are `/goal*`, `/list*`, `/loop*`. No `pi-gla-` prefix, no `oracle/sisyphus/squad/forge` metaphors anywhere (code, files, docs, keywords).

### Non-goals (v0.x)

- No interop with `pi-goal-x` state (`.pi/goals/`). Clean break, `.pi-gla/` only.
- No web dashboard, no remote control, no multi-machine coordination.
- No planner/decomposer that invents the goal for the user (drafting *clarifies*; it does not originate).

---

## 1. Milestones & acceptance criteria

### M0 — v0.1.0-alpha.1 scaffold ✅ (done)

- [x] Package layout, LICENSE, README, CHANGELOG, DESIGN, tsconfig
- [x] `extensions/loops/goal.ts` — commands + agent tools + agent_end loop
- [x] `extensions/goal-loop-core.ts` — types, JSONL ledger, markdown renderer
- [x] `extensions/goal-loop-auditor.ts` — isolated auditor session
- [x] `extensions/goal-loop-backoff.ts` — 5-min hard cap
- [x] `prompts/goal-loop-continuation.md`, `schemas/goal.schema.json`
- [x] 24 unit tests green (`npm test`)
- **Exit evidence**: `npm test` → 24/24 pass (verified 2026-07-20).

### M1 — v0.1.0 (first real release)

Scope: make the goal loop actually work end-to-end in a live pi session. No new features.

- [ ] **Type-check clean**: `npm run check` (tsc --noEmit) → 0 errors.
  - Known risk: `ExtensionContext`, `defineTool` import path, `pi.registerCommand` arg shapes were written against memory of pi-goal-x, not verified against the installed pi 0.74 API.
- [x] **Live smoke test** ✅ 2026-07-20 — full loop verified end-to-end in tmux: `/goal` → agent works → `complete_goal` → isolated auditor (opencode/deepseek-v4-flash-free, extension-less) approves → archived with clean 1-entry history + real auditor report.
- [x] **Fix whatever the smoke test breaks** ✅ — 6 real fixes: (1) API imports from public entrypoint + pi-ai/pi-agent-core types; (2) `sendMessage` on `pi` API not `ctx`; (3) stale-ctx crash → `lastCtx`/`rememberCtx` pattern; (4) `details:{}` in tool results, async handlers, `tool_call` event name; (5) auditor model default → `ctx.model` + string-ref resolver; (6) audit-history pollution — record only non-empty reports, cap at 20, include `error` field.
- [x] **Escape hatch verified** ✅ (with caveat) — Esc during audit aborts the pi turn; the auditor session may complete detached. Loop recovers cleanly via `agent_end` (verified live: 3 empty audits then approval). pi-goal-x's fancy Escape dialog is v0.2.0 scope. Abort signal is threaded into the auditor for when pi wires tool-level abort properly.
- [x] **Backoff cap verified** ✅ (incidentally, live) — openrouter 403 storm triggered exactly "Goal paused: 5 consecutive errors" auto-pause.
- [ ] Update CHANGELOG, tag `v0.1.0`, `npm publish`.

**Live smoke script** (target: < 5 min):
```
pi -e /home/dracon/Dev/pi-goal-loop-audit
> /goal "Create file hello.txt containing the word world. Done when: grep -q world hello.txt"
# expect: agent writes file, calls complete_goal, auditor approves, goal archived
> /goal status        # expect: complete, audit history shows 1 approved
cat .pi-gla/active.jsonl | tail -3
ls .pi-gla/archive/   # expect: one .md file
```

### M2 — v0.2.0 (list + drafting + regression_shield) ✅ (2026-07-20)

- [x] **Loop 2: `/list`** — `add|show|next|remove <n>|clear`; each item is a full goal; completing/aborting one auto-activates the next; session restart resumes a non-empty queue. Live-verified: two items auto-advanced through audit to archive.
- [x] **Drafting**: `/goal` no-args → agent grills one question at a time → `propose_goal_draft` → real Confirm dialog. Live-verified end-to-end (drafted goal completed with shield).
- [x] **regression_shield**: auditor must quote raw output per contract item in an `<evidence>` block; orchestrator converts evidence-free `<approved/>` into disapproval. Pure logic in `goal-loop-shield.ts`; 14 unit tests + live verification (verbatim `<evidence>` in history).
- [x] **Escape dialog**: abort → complete-without-audit / continue choice.
- [x] **Provider warning**: one-time `session_start` notice when the session provider isn't a confirmed built-in and no auditorModel is set. Live-verified on kilocode.
- [x] **Inline contract extraction**: one-liner `Done when:` now extracts (was silently skipped before — the shield never engaged on one-liners).
- [x] **Live integration harness**: `scripts/smoke.sh [goal|list|draft]` — goal scenario 5/5 assertions green.
- [x] CHANGELOG, version 0.2.0, publish.
- [ ] `max_subtasks_per_task` cap → moved to M3 (no task-list creation tool exists yet; capping nothing is premature).

### M3 — v0.3.0 (loop) ✅ (2026-07-20) — design

**Loop 3 is metric-driven, not vibes-driven.** This is the anti-doorknob design:
pi-loop-mode's failure mode was endless "improvement" churn (the DOORKNOB problem).
Our loop only believes a number.

**Model**:
- User supplies: `target` (what to improve), `measure` (shell command that prints
  a number), `direction` (min|max). Optional: `window` (plateau window, default 5),
  `max` (iteration cap, default 50).
- On `/loop start`: orchestrator runs `measure` → baseline.
- On every `agent_end` while active: orchestrator runs `measure` → compare to best:
  - improved (min: value < best; max: value > best) → new best, stall=0
  - not improved / measure failed → stall++
  - The **orchestrator** runs the measure (via `pi.exec`), never the agent —
    the agent cannot fake the number.
- Stop conditions: `stall >= window` (plateau), `iteration >= max`, or `/loop stop`.
- No git-based auto-revert in v0.3.0 (too dangerous with uncommitted user work);
  on regression the agent is instructed to undo its own last change, and the next
  measure verifies.
- **No auditor in loop 3**: the metric IS the verdict. Documented.
- Mutual exclusion: a `/loop` cannot start while a goal/list is active and vice versa.

**Command shape**: `/loop start "<target>" measure="<cmd>" direction=min [window=5] [max=50]`
`/loop` (status) · `/loop stop`

**Collision note**: `/loop` collides with pi-loop-mode — the M1 collision detector
handles UX; smoke tests run under a bare `PI_CODING_AGENT_DIR` to isolate.

**Also in M3**:
- `propose_task_list` tool + `max_subtasks_per_task: 5` cap (M2 carry-over — makes
  the existing complete_task/update_task_status tools actually usable).
- `notify=<cmd>` setting: shell out on goal complete / goal pause / loop stop
  (message passed as `$1`; config-gated, no deps).
- Unit tests (metric parse, plateau logic, task cap) + `/loop` smoke scenario.

**M3 verification evidence** (all live, 2026-07-20):
- `/loop` smoke: metric 5→0 over 5 improving iterations (stall reset each time),
  3 stall iterations at 0, plateau stop at window=3, `loop_stopped` + per-iteration
  `loop_measured` in ledger, notify fired on stop. `scripts/smoke.sh loop` 5/5.
- Regression check: `goal` 5/5, `list` 4/4, `draft` 3/3 — all scenarios hermetic
  (bare agent dir + readiness wait) after two collision/REPL-race flakes.
- 73 unit tests green; `tsc --noEmit` clean.
- Found + fixed during M3: `/gla` whitespace split mangled quoted
  notify commands; smoke `wait_for "plateau"` matched agent prose instead of
  the orchestrator's stop text (assertions raced the loop).

### M7 — v0.7.0 (global config tier) ✅ (2026-07-21)

User directive: settings are not per-goal/loop/list — there should be ONE
global config you set once and rarely open. Shipped: project > global >
defaults resolution, `/gla` writes global by default (`project`
prefix for local overrides), provenance display, 4 mergeSettings unit tests,
live-verified both tiers + no-leak smoke. Docs updated.

### M6 — v0.6.0 (draft everything) ✅ (2026-07-20)

User directive: for a long-running thing, a draft up front is better. Drafting
exists only for `/goal`; `/list add` takes raw strings, and `/loop start`
demands a correct target+measure+direction in one blind shot — the most
expensive place to be wrong (up to 50 iterations before plateau stops a bad
metric). Draft all three loops; for `/loop`, validate the metric BEFORE
confirming.

1. **Unified drafting modes**: drafting target becomes `"goal" | "list" |
   "loop"`. `/goal` (existing), `/list add` with no args (draft → confirmed
   contract goes into the QUEUE instead of activating), `/loop` with no args
   (draft → confirmed loop config starts the loop).
2. **`/loop` drafting with measure test-run** (centerpiece): the agent grills
   about target + what number represents progress, then calls
   `propose_loop_draft(target, measureCmd, direction, window?, max?)`. The
   **orchestrator runs the measure command once** and shows target + measure +
   real output + parsed number + direction in the Confirm dialog:
   "`grep -c TODO src.txt` → `42` (min). Start?" A broken measure (no number)
   is shown as such and the agent is told to fix the proposal. User validates
   the metric before a single iteration burns tokens.
3. **`/goals` archive browser**: list archived goals (id, status, stop reason,
   objective head) from `.pi-gla/archive/`. Long-running tool needs history.
4. Gates: unit tests (draft-mode routing, loop-draft measure parsing), smoke
   scenarios for loop-drafting and list-drafting, publish v0.6.0.

**M6 evidence** (2026-07-20):
- Loop drafting live: agent located num.txt itself, proposed `cat num.txt`;
  Confirm dialog showed the real test-run ("Parsed number: 10, lower is
  better"); confirmed loop ran improving iterations immediately.
- List drafting live: confirmed contract → list_added → auto-activate →
  audited → archived.
- `/goals` parsing verified against real archive entries.
- 89 unit tests, tsc clean.

**Still deferred**: live footer/TUI widget (now the ONLY remaining scoreboard
gap vs pi-loop-mode/pi-goal-x).

### M5 — v0.5.0 (self-sufficiency) ✅ (2026-07-20)

User directive: a goal loop that dies silently after compaction and needs an
EXTERNAL plugin (`@badliveware/pi-compaction-continue`) to restart it is a hole
in OUR plugin. Liveness is the loop's own job. Bake it in; cut the watchdog.

1. **Heartbeat self-watchdog** (replaces pi-compaction-continue for our loops):
   a 15s interval checks: active goal-or-loop AND session idle AND no pending
   continuation/loop timer AND no activity for 60s → re-fire the continuation.
   One check covers every stall cause (compaction-eaten turn, dropped message,
   stale ctx). Stall accounting: a heartbeat-nudged turn with ZERO tool calls
   counts as a nudge; 3 consecutive → pause (mirrors the watchdog's 3-nudge cap,
   but scoped to real goal progress). Pure decision function unit-tested.
   Scope note: this covers stalls while a goal/loop is active. Non-goal sessions
   are the user's own business — they are at the keyboard.
2. **`/goal tweak "<text>"`** — edit the active goal's objective in place
   (Confirm dialog shows old vs new; contract re-extracted from the new text).
   Closes the last pi-goal-x feature gap we use.
3. **Structured drafting forms**: drafting prompt prefers `ask_user_question`
   (rpiv-ask-user-question) when the tool is available in the session — closes
   the structured-forms gap vs pi-goal-x without a hard dependency.
4. **Rig cuts** (after publish): `pi-codex-goal`, `pi-loop-mode`,
   `@badliveware/pi-compaction-continue`. AGENTS.md stack table rewritten:
   goal plane = pi-goal-loop-audit.

**M5 evidence** (2026-07-20):
- Heartbeat: 8 unit tests for the stall predicate + nudge accounting; `goal`
  smoke 5/5 with the heartbeat interval live through the full cycle.
- `/goal tweak`: implemented with Confirm dialog + contract re-extraction.
- Drafting prompt prefers `ask_user_question` when available.
- 89 unit tests, tsc clean.

**Deferred**: live footer/TUI widget (pi-loop-mode's dashboard is the one thing
we genuinely lose by cutting it; v0.6.0 candidate if missed).

### M4 — v0.4.0 (completion release) ✅ (2026-07-20)

Everything left, in one release. Completes the 6-flaw list and makes the docs honest.

1. **Auditor compaction (flaw #3 — the LAST open flaw)**. Enable pi's built-in
   compaction in the auditor session (currently `compaction: { enabled: false }`).
   Safety argument: regression_shield is orchestrator-side — a compaction-degraded
   auditor produces weaker evidence → disapproval, never false approval. The risky
   direction (silent false approval) is structurally impossible.
2. **Schema + examples + docs sync**. `schemas/goal.schema.json` still says "oracle"
   and "v0.1.0 loop 1 only"; `examples/example-objective.md` still uses `/pi-gla-set`;
   `tests/README.md` has stale counts; `docs/DESIGN.md` needs the v0.2/v0.3 addendum.
3. **tokensUsed wiring + limit enforcement**. `AgentEndEvent.messages` carries
   `usage.totalTokens` per assistant message — accumulate per goal. `tokensLimit`
   becomes a real cost guard: crossing it pauses the goal with a clear reason
   (configurable via `/gla tokenlimit=`).
4. **Resumption notice** on `session_start`: if a goal is active or a loop is
   running, say so. (The "plugin vanished" self-check from D4 is impossible from
   inside the plugin — absent code cannot run. Recorded as rejected.)
5. **Loop 3 git-branch mode** (`branch=1` flag): at `/loop start`, create scratch
   branch `pi-gla-loop/<id>`; commit after each improving iteration; on regression
   `git reset --hard` to the last improving commit ON THE SCRATCH BRANCH ONLY.
   The user's branch and uncommitted work are never touched. Requires: git repo,
   and we refuse `branch=1` with a dirty tree (refuse to mix user work into the
   scratch branch).
6. **Draft reject path** in the smoke harness (Confirm → No → agent refines).

After M4 the 6-flaw list is closed and the roadmap table is all-shipped.

**M4 verification evidence** (all live, 2026-07-20):
- Auditor compaction enabled; `goal` smoke 5/5 green after the change.
- Token guard: 3 unit tests for dedup accumulation; limit-pause path wired in
  agent_end with settings-configurable budget.
- branch=1 live: 5 improvement commits on scratch branch, 0 for stalls, main
  untouched, returned to main on plateau with merge instructions.
- `draft-reject` smoke 6/6: Confirm → reject → refine → Confirm → approval.
- Resumption notice on session_start for active goal/loop.
- 81 unit tests, tsc clean, all 5 smoke scenarios green.
- **6/6 pi-goal-x flaws now closed.** The D4 "plugin vanished" self-check is
  recorded as REJECTED (absent code cannot run); replaced by the resumption
  notice.

**Deferred to v0.4.0 (with justification)**: (superseded — this release)

---

## 2. Open decisions (must resolve before M1 publish)

### D1 — Command collision strategy ✅ RESOLVED

**Verified in installed pi source** (`dist/core/extensions/runner.js:resolveRegisteredCommands`):
- Duplicate command names **never throw** and **never clobber** — both survive.
- First registrant keeps the bare name (`/goal`); later ones get `/goal:2`, `/goal:3`, …
- So the failure mode is degraded UX (our command reachable as `/goal:2`), never breakage.

**Decision: option 1 — plain names + detect-and-warn.** Implemented in `extensions/loops/goal.ts:warnOnCommandCollision`: at `session_start` we count registered command names via `pi.getCommands()`, and if any of ours (`goal`, `list`, `loop`, `goal-*`) appears more than once we notify the user with the degraded invocation name. Collision check is fail-silent (non-fatal by design).

### D2 — Auditor model default ✅ RESOLVED (with a hard discovered constraint)

**Discovered during M1 smoke (2026-07-20): the auditor session has no extensions, so it can only use BUILT-IN providers.** On this rig the main session ran kilocode (`tencent/hy3:free`) — an extension-registered provider — and every auditor spawn failed with `No API key found for kilocode`. Verified bare-session matrix: `opencode/deepseek-v4-flash-free` works extension-less; kilocode/zenmux/kimi-coding do not.

**Decision**: default = session model (works when the session model is built-in); `/gla model=provider/id` overrides for rigs running extension-provided session models. The `/gla` save message now warns about the built-in-provider constraint. `resolveAuditorModel` documents it in code. v0.2.0 should add a startup check: if session model's provider is extension-registered and no auditorModel is set, warn once.

### D3 — State dir name ✅ RESOLVED

**Keep `.pi-gla/`.** Internal-only path; renaming costs a migration for zero user-visible gain. If we ever regret it, the rename is a one-line constant (`piGlaDir` in `goal-loop-core.ts`) plus a migrate-on-read.

### D4 — Persistence across pi updates ✅ RESOLVED

Known rig behavior (from earlier audits): `pi update` overwrites `~/.pi/agent/npm/node_modules/`, which can wipe npm-installed plugins. **Decision: document both install paths in INSTALL.md** — `pi install npm:pi-goal-loop-audit` (convenient, re-install after `pi update`) and project-local `.pi/extensions/` (permanent, survives updates). The `-e <path>` dev flow is unaffected. v0.2.0 should add a `session_start` self-check that notifies if the plugin vanished from the loaded set while `.pi-gla/active.jsonl` shows an active goal.

---

## 3. Verification gates (apply to every milestone)

A milestone is not done until:

1. `npm test` green (unit).
2. `npm run check` clean (types).
3. Live smoke passes (M1+).
4. CHANGELOG entry written.
5. No `oracle|sisyphus|squad|forge|pi-gla-` string outside `.pi-gla/` dir name (run the grep).

```bash
grep -rn "oracle\|sisyphus\|squad\|forge" \
  tests/ extensions/ prompts/ docs/ examples/ README.md INSTALL.md CHANGELOG.md package.json \
  | grep -v node_modules
# expect: no output
```

---

## 4. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| pi extension API drift (0.74 → next) | medium | pin peerDeps `*`; smoke test after every pi update |
| Command collision (D1) | high | resolve D1 before publish |
| Auditor cost (every complete_goal = extra session) | medium | D2 settings; document cost expectation in README |
| User installs alongside pi-goal-x and gets two loops fighting | medium | README "conflicts" section; loud notify if `.pi/goals/` detected |
| v0.1.0's auditor is rubber-stampable (`bash true`) until v0.2.0 regression_shield | known/accepted | documented in DESIGN + README; ship v0.2.0 fast |

---

## 5. Publish checklist (M1)

- [ ] D1–D4 resolved and recorded in this file
- [ ] `npm test` + `npm run check` + live smoke all green
- [ ] Version bump `0.1.0-alpha.1` → `0.1.0`
- [ ] git init + initial commit + GitHub repo `dracon/pi-goal-loop-audit`
- [ ] `npm publish --access public`
- [ ] Verify: `pi install npm:pi-goal-loop-audit` on a clean rig
