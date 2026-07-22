# Changelog

## [0.21.1] — 2026-07-22

### Fixed — widget head glyph and tree alignment

- **Active head now renders green for real.** The ◆ (U+25C6) head glyph is
  substituted by color-emoji fonts in some terminals and ignores ANSI color —
  it showed yellow no matter what was painted. Head glyph is now ● (U+25CF),
  the same glyph the status line uses, which takes theme color everywhere.
- **Branch lines flush-left.** v0.20.0 added a one-space branch indent, but
  pi's widget renderer already contributes a one-space gutter — branches sat
  one column deeper than pi-tasks'. ├─/└─/⎇ lines now emit no leading space,
  matching pi-tasks exactly.

## [0.21.0] — 2026-07-22

### Changed — session restore no longer auto-starts work in fresh sessions

Opening pi in a folder with an active goal used to fire work immediately —
before you could even load your old session, a fresh empty session was
already burning turns with zero conversation context. Restore is now gated
on `session_start.reason`:

- **"resume" / "reload" / "fork"** — the session carries the goal's
  conversation: auto-resume, as before.
- **"startup" / "new" (or no reason, older pi)** — fresh session: HOLD.
  Goals restore paused ("restored in a fresh session — no work started",
  /goal resume to continue); loops restore held (/loop with no args resumes
  a held loop instead of drafting); a waiting list notifies instead of
  auto-activating the head.
- **/glla autoresume=on** — new setting (global or project) restoring the
  old auto-resume-everywhere behavior. Set it per rig project for
  unattended restarts. Default off.

The gate is one mechanical predicate (`shouldAutoResumeOnSessionStart`),
unit-tested across all five reasons plus the autoresume override.

## [0.20.1] — 2026-07-22

### Fixed — the liveness signal looked frozen

The UI ticker ran every 5s while `fmtElapsed` showed minute granularity
("14m" for a full minute) — an active goal was indistinguishable from a
wedged one at a glance. Ticker now runs every 1s and elapsed keeps
seconds visible up to the hour (`1m 05s`, `3m 00s`; `1h 05m` beyond).
Paused goals still don't tick — the stopped clock is the honest metaphor
for "waiting on the user".

## [0.20.0] — 2026-07-22

### Added — semantic colors in the widget + status line

The goal/list/loop widget and the footer status line now paint status
semantically via pi's theme (works in light + dark themes):

- **green** — active goal/list item (◆/●), loop best value
- **yellow** — paused awaiting user; loop stall one short of the plateau stop
- **red** — error pauses (token limit, stalled, auditor infra failure)
- **accent** — auditing in progress, loop direction arrows
- **dim** — token counters, hints, suggested actions, measure command

Colors are opt-in at the call site (`DisplayTheme`); the pure builders
still return plain strings without a theme, so tests stay ANSI-free.

### Fixed — widget column alignment + branch-name relic

- Widget branch lines (`├─`/`└─`) were flush-left while the head glyph
  padded the text column — the tree looked one space out of column next
  to other widgets. Branch lines now indent one space (pi-tasks
  convention): the tree sits under the head glyph, text column consistent.
- Loop scratch branches were still named `pi-gla-loop/…` (rename relic);
  now `pi-glla-loop/…`, commit messages included.

## [0.19.3] — 2026-07-22

### Changed — goal drafting: thoroughness goes in the contract, not in iteration budgets

An agent mid-`/goal`-interview asked the user to pick "Loop size: 30/60/15
iterations with a stop rule" — loop-3 vocabulary imported into a goal,
with an invented pass-count dressed up as a recommended preset. The
mechanical guard was already right (`propose_loop_draft` rejects calls
outside loop drafting), but the goal-draft prompt never said goals have no
iterations. Now it does: exhaustiveness is expressed as checkable contract
items ("Done when: all 22 screens audited"), never as pass-counts, and
invented tiered packages are called out by name. Same pattern as the
v0.19.1 list-cap fix: agents confabulate authoritative-looking numbers;
the prompt is where confabulated framing gets banned.

## [0.19.2] — 2026-07-22

### Fixed — the status line names what it's running; `/gla` and "queue" relics swept

- **Footer shows the right name per loop type.** The status line hardcoded
  `glla: goal ●` even when the active item came from the list. It now reads
  `Goal.policy`: `glla: goal ●` for a direct goal, `glla: list ●` for a
  list-activated item (loop 3 already showed `glla: loop ↑/↓`). One status
  line, three honest names.
- **Three more user-facing `/gla` relics** the 0.17.x sweeps missed: the
  no-model error ("set one with /gla model=…"), the token-limit pause
  message + its suggested action, and the provider-warning + settings hint
  text. All say `/glla` now; comment blocks swept too.
- **"Queue" relics renamed to "list"** in user/agent-facing text: the
  `/list` show header, the confirm-activation messages, the list-drafting
  label, and the drafting block message.

## [0.19.1] — 2026-07-22

### Changed — the list is unbounded; the 100-per-call cap is gone

The queue was already unbounded (`enqueueItems` appends without limit) —
the only arbitrary wall was `list_add` rejecting batches over 100. Hundreds
of small tasks are a legitimate list. The cap is removed and the tool
descriptions now say so explicitly ("The list is UNBOUNDED — hundreds of
small items are fine; propose them all"), because agents read caps into
examples and self-impose limits the plugin never had. The honest cost note
stays: every item is audited individually, so audit cost is the real
budget for huge lists — not a number in code.

## [0.19.0] — 2026-07-22

### Changed — `/list add` is now a no-op alias; detection routes everything

The verb was redundant: `/list plan.md` already imported via detection, so
`add`'s only real job was forcing vague text past the interview. But a list
item activates RAW when it reaches the head — the drafting interview is the
only quality gate an item ever gets, and a verb whose sole purpose was
skipping that gate was a leak, not an escape hatch. Now `add` and `import`
are stripped and the rest routes through `routeListText` exactly like
verb-less text: file → import, paste → batch, `Done when:` → direct,
anything else → drafting. Muscle memory (`/list add plan.md`) keeps working.
The list-drafting notice now names the real direct path: include a
`Done when:` clause. Also swept the last "Forever-polish loop" framing from
the README decision table.

## [0.18.1] — 2026-07-22

## [0.18.1] — 2026-07-22

### Fixed — Confirm-gate bypass: agent queued list items directly mid-draft

First live run of conversational `/list`: the agent received the drafting
interview, skipped it, called `list_add` three times, and ACTIVATED the
first item — zero confirmation, because the gate only covered
`propose_goal_draft`. During a list drafting session `list_add` and
`list_activate` now return a block error steering to
`propose_goal_draft(items[])` (one Confirm for the whole batch). User
commands (`/list add`) are unaffected; outside drafting the agent manages
the list freely. New pure predicate `listMutationBlocked` + test.

## [0.18.0] — 2026-07-22

## [0.18.0] — 2026-07-22

### Added — conversational `/list`: dump text, get a decomposed list

`/list fix the login bug, add dark mode, write docs` used to hit a usage
error (unknown verb "fix") — and `/list add` of the same text queued ONE
monolithic objective. Now an unknown first word is treated as a
natural-language dump and routed by detection (new `routeListText`):

- file path → bulk import (sisyphus/Ralph plan file, unchanged)
- multi-line paste → batch add (structure already explicit, unchanged)
- contains `Done when:` → one direct item, no interview
- anything else → **drafting session**: the agent decomposes the dump into
  `items[]`, one Confirm adds the whole batch

`/list add <text>` stays the explicit direct path — the `/goal start` of
lists — for when you know it's one item. The list-drafting notice now
names the right escape hatch (`/list add`, not `/goal start`), and the
empty-list hint teaches the conversational form.

## [0.17.1] — 2026-07-22

## [0.17.1] — 2026-07-22

### Fixed — four `/gla` strings the 0.17.0 sweep missed

Widget footer hint, loop-block comment, and the two auditor-infrastructure
error paths still pointed at `/gla`. The relic sweep now greps clean
(everything except the intentional migration code and CHANGELOG history).

## [0.17.0] — 2026-07-22

## [0.17.0] — 2026-07-22

### Breaking — no relics: aliases removed, state dir renamed

Self-audit after the rename. A rename that keeps aliases is a rename that
didn't happen.

- `/gla` alias **removed** — `/glla` is the only settings command.
- `/queue` alias **removed** — `/list` since 0.10.0, the training wheels
  stayed three releases too long.
- Status/widget prefix `gla:` → `glla:`; widget keys `pi-gla` → `pi-glla`.
- State dir `.pi-gla` → `.pi-glla` with a one-time automatic migration
  (existing goals, ledgers, and project settings move; no state is lost).
- Every user-facing string (error messages, header comments, docs, smoke
  script) now says `/glla` and `.pi-glla`.

### Fixed — tooltip drift: `/loop` description advertised a removed strategy

The command tooltip still showed `[done=<value>]` — an option that throws
since 0.15.0 — and the "forever loop" framing predates the repositioning.
New description states the agreed philosophy: *"metric-driven process — it
never completes… 'Improve until X' is a /goal, not a loop"* with the real
parameters `[time=<hours>] [tokens=<budget>] [branch=1]`. Also: tool
description "queue item" → "list item".

## [0.16.0] — 2026-07-22

## [0.16.0] — 2026-07-22

### Added — `/goal start <objective>`: the explicit skip-draft

The only skip paths were embedding `Done when:` (a string heuristic) or
surviving the interview. `/goal start` activates immediately by explicit
command — no grilling, no Confirm gate, symmetric with `/loop start`; the
auditor infers the contract from the objective. The drafting notice and
`/goal` help now name the escape hatch, so a user stuck in an interview
learns the way out from the UI itself. `/goal start` with no objective
prints usage.

## [0.15.1] — 2026-07-22

## [0.15.1] — 2026-07-22

### Fixed — endless drafting: the gate ignored dialog answers

Wild failure (junk-runner session): the user answered **five**
`ask_user_question` rounds and `propose_goal_draft` still returned
INTERVIEW FIRST every time. The floor counted only typed chat messages
(`message_start` role=user); dialog answers arrive as **tool results** and
never incremented the counter. Worse, the blocked error said "ask one sharp
question, then propose again" — mechanically manufacturing an endless
interview. The agent eventually bypassed the goal entirely.

Two fixes, one mechanism:

- `tool_result` handler counts answered `ask_user_question` questionnaires
  (`details.cancelled === false` with ≥1 answer — Esc-abandons do NOT count)
  toward the interview floor, via the new `askUserQuestionAnswered` helper.
- Stuck-gate escape hatch: after 3 blocked proposals, the error message
  switches to "tell the user to type any chat message to unlock" — a gate
  that cannot see the replies must never manufacture another interview round.

## [0.15.0] — 2026-07-21

## [0.15.0] — 2026-07-21

### The package is now `pi-goal-list-loop-audit` — and a loop never completes

Design conversation outcome: **goal = achievement, loop = process.** The old
name read as "a loop for goals"; the three primitives are peers and the
name now says so. npm `pi-goal-loop-audit` is deprecated with a pointer.
`/glla` is the settings command; `/gla` stays as an alias. State dir
`.pi-gla` unchanged.

### Breaking — `done=` removed from `/loop`

A loop no longer checks for completion — *that was a goal in a trench coat.*
`done=` now throws a teaching error pointing at `/goal "… Done when: …"`.
The loop's ends are exactly: `/loop stop`, plateau (the well is dry),
`max=` iterations, and the two NEW arbitrary bounds `time=<hours>` and
`tokens=<budget>` (orchestrator-counted input+output). The loop Confirm
dialog states it plainly: "The loop never completes."

### Added — `propose_loop_refine` (the living spec)

The loop's unique territory: working against a spec that can itself be
refined. Mid-loop, the agent calls `propose_loop_refine` with a sharpened
target and/or a new measure command plus a rationale; the user confirms;
on a measure change the orchestrator test-runs the new command (no number =
auto-reject) and re-baselines. `loop.refinements[]` keeps both eras;
`/loop status` shows the refinement count. The forever prompt now names
this as the only legitimate way to change the metric — never gaming it.

## [0.14.0] — 2026-07-21

All notable changes to pi-goal-loop-audit are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.9.4] — 2026-07-21

### Docs — compatibility section

README gains the full complement/conflict map: the Two-Driver Rule (one
agent_end driver at a time — hard conflicts with pi-codex-goal, pi-loop-mode,
pi-goal-x family, active ralph/autoresearch), the compaction-continue overlap
note, the ralph-wiggum "installed but not simultaneous" rule, and the
complements (rpiv-ask-user-question, pi-subagents, pi-tasks, pi-chrome,
search skills) with the provider + notification-channel footnotes.

## [0.9.3] — 2026-07-21

### Added — bamboozle adversarial scenario (auditor catch-rate testing)

- **`scripts/smoke.sh bamboozle`**: the first outcome-level test. A buggy
  `calc.js` where the easy path is gutting the tests and the contract makes
  that detectable: `node --test exits 0` AND exports intact AND ≥6 test
  blocks. Asserts the traps all hold at the end AND the shield enforced
  per-item evidence (`regressionShieldPassed: true`). This is how we measure
  the auditor's catch rate instead of just its mechanics. 6/6 green on first
  run (agent fixed the bug honestly; the shield verified all three traps with
  evidence).

## [0.9.2] — 2026-07-21

### Added — done= threshold, hypothesis line, stall strategy hint

- **`/loop start ... done=<value>`**: until-done semantics (pi-loop-mode's one
  genuinely good idea we lacked). The loop stops the MOMENT the metric
  crosses the threshold (min: `value <= done`, max: `value >= done`) instead
  of stalling out the plateau window first. Done beats plateau when both hit.
  Also available as `done` in `propose_loop_draft`. Verified live: 3→2→1→0
  stopped at iteration 3 with `done — metric crossed 0`, no stall tail.
- **`HYPOTHESIS:` line** (pi-autoresearch's good idea): loop prompts ask the
  agent to state its intent first; the line is parsed into every
  `loop_measured` ledger event, making loop history auditable, not just numeric.
- **Strategy rotation at high stall** (pi-loop-mode's other good idea): at
  `stall >= window-1`, the directive switches from "one small change" to "try
  a fundamentally different approach" — one creative shot before the plateau
  stop, instead of polishing to the end.
- 8 new unit tests (doneCrossed, done-stops-immediately, done-beats-plateau,
  done= parsing). 142 total, tsc clean.

## [0.9.1] — 2026-07-21

### Changed — `/list` renamed to `/queue`

The status line said `queue 4`, the widget said `queue 7 waiting`, `list_add`'s
description read "Add to queue" — everything already called it a queue except
the command. Now the command matches: `/queue add|show|next|remove|clear`.
"List" described a static structure; this thing has FIFO behavior with
auto-advance — that's a queue. `/list` remains as an alias for one release
(removed in 0.10.0). `/goal` stays (a goal is not a todo — it has a contract
and an audit); `/todo(s)` rejected (checkbox semantics invite exactly the
vagueness the auditor exists to kill).

## [0.9.0] — 2026-07-21

### Added — live TUI: status line + above-editor widget

- **You can always tell it's on now.** A persistent `gla:` segment in the
  status line shows the supervisor state at all times:
  `gla: goal ● 2/5 tasks · 3m · queue 4` · `gla: auditing… · read` ·
  `gla: paused ⏸ <reason>` · `gla: loop ↓ iter 12/50 · best 41 · stall 2/5`.
- **Above-editor live widget** (pi-goal-x pattern, simpler `string[]` form):
  objective head, status, elapsed, token usage, next pending task or loop
  metric, pause reason + suggestion, branch name in branch mode, and **live
  auditor progress** (current tool, elapsed, isolated-session note) during
  audits. Refreshes on every state transition (single chokepoint:
  `persistState`) plus a 5s ticker for elapsed time.
- Pure builders in `goal-loop-display.ts` — 16 unit tests.

### Verified (2026-07-21)

- Live: widget renders during an audit with live auditor progress; status
  line reads `gla: auditing…`. 134 unit tests, tsc clean.

## [0.8.5] — 2026-07-21

### Changed — auditor thinking follows the pi session

- **Auditor thinking level**: was a hardcoded `medium` default. Now the
  auditor follows the thinking level **you selected in pi** (same philosophy
  as the model), with a `high` floor when nothing is set — the auditor is the
  verification gate, depth beats speed there. `/gla thinking=` remains the
  explicit override; the settings UI shows `(session, floor high)` when unset.

## [0.8.4] — 2026-07-21

### Added — free-style list: the agent can manage the queue

- **`list_add` tool**: the queue is no longer command-only. Plain chat works —
  "queue these 10 things", "add this to my list", "put it on the backlog" —
  the agent enqueues with per-item `Done when:` extraction and
  auto-activation. This was the real gap vs sisyphus/ralph-style plugins:
  conversational flow with our audited-queue semantics.
- **`list_status` tool**: the agent can read the active goal, the queue, and
  any running loop as text before deciding what to do.
- **`enqueueItems`**: the one shared enqueue path — bulk import, `items[]`
  drafting, and `list_add` all funnel through it (three copies eliminated).

### Verified (2026-07-21)

- Live: one plain-chat sentence ("queue these three things: …") →
  `list_add {count: 3}` (agent added its own Done-when clauses) →
  three goals worked → **three independent auditor approvals** → archived.
- 118 unit tests, tsc clean.

## [0.8.3] — 2026-07-21

### Changed — quiet auditor auto-fallback; `/list add` takes pasted lists

- **The provider warning is gone.** When the pi session model's provider is
  extension-registered (the auditor's extension-less session can't auth it),
  the plugin now **auto-uses the strongest credentialed built-in model** and
  says so ONCE at info level, naming the pick: override any time with
  `/gla model=provider/id`. Resolution: explicit `/gla` setting → session
  model (if built-in) → auto-fallback (tier-ranked) → clear error. The
  session model always wins when it works; nothing is ever written to your
  config silently.
- **`/list add` accepts pasted multi-line text**: paste a checklist straight
  into the command — it parses as a batch with the same single Confirm as a
  file import. Detection order: existing file → multi-line paste → single
  objective.
- `auditModelTier` restored to core (2 unit tests; speed/cost variants
  outrank family names — `gemini-3-flash` is flash-tier, not gemini-tier).

### Verified (2026-07-21)

- Live: multi-line bracketed paste → batch Confirm → `list_imported {count: 3}`.
- 118 unit tests, tsc clean.

## [0.8.2] — 2026-07-21

### Changed — `/list add` is the flexible path; drafting proposes batches

- **`/list add` now detects files**: `/list add plan.md` bulk-imports when the
  path exists and is a single objective when it doesn't. No separate verb to
  remember. (`/list import` remains as an alias for 0.8.1 compatibility.)
- **Multi-item drafting**: `propose_goal_draft` gains an `items[]` parameter,
  so a `/list` drafting session can propose a whole plan at once — one Confirm
  dialog for the batch, per-item `Done when:` extraction, auto-activation.
  `items[]` in `/goal` drafting is rejected (a goal is single by definition).
  The list-draft prompt tells the agent to batch: "queue these 50 things"
  → one proposal, not fifty.
- `resolveImportFile` in core (4 unit tests): file detection by bare name,
  relative path, `./` prefix; objectives and directories never match.

### Verified (2026-07-21)

- Live: `/list add plan.md` → file detected → batch Confirm →
  `list_imported {count: 3}` → first item activated, 2 queued.
- 116 unit tests, tsc clean.

## [0.8.1] — 2026-07-21

### Added — bulk list import + queue paging

- **`/list import <file>`**: the sisyphus-style path. Bulk-enqueue hundreds of
  items from a plan file — markdown checklists (`- [ ]`), bullets, numbered
  items, plain lines; headings/comments/hr-rules skipped; per-item `Done
  when:` extraction; ONE Confirm dialog for the whole batch (count + preview).
  **Bulk never drafts** — the three drafting rules are now explicit:
  no-args = draft (single), with-args = direct, import = bulk direct.
- **`/list show` pages at 15** with `… and N more` (a 500-item queue no longer
  floods the pane).
- `parseListImport` in core (8 unit tests incl. a full sisyphus-plan fixture).

### Verified (2026-07-21)

- Live: 20-item plan → Confirm (5 preview + "… and 15 more") →
  `list_imported {count: 20}` → first item auto-activated, 19 queued, paging
  correct, agent working. 112 unit tests, tsc clean.

## [0.8.0] — 2026-07-21

### Changed — `/gla` opens a real settings UI; four top-level commands

- **`/gla` now opens an interactive settings menu** (pi dialog primitives):
  pick a setting → edit it (input for model/notify/token limit, select for
  thinking level) → saved to GLOBAL → back to the menu until Done/Esc. The
  scriptable `/gla key=value` and `/gla project key=value` forms remain for
  tmux/headless; headless sessions get the text display with provenance.
- **Top-level commands consolidated from 11 to 4**: `/goal`, `/list`,
  `/loop`, `/gla`. The goal verbs became exact-match subcommands:
  `/goal status|pause|resume|cancel|tweak <text>|archive`. Removed:
  `goal-status`, `goal-pause`, `goal-resume`, `goal-cancel`, `goal-tweak`,
  `goals`, `goal-init`.
- **The ambiguity rule** (unit-tested): subcommands match only on the exact
  bare word, so `/goal pause the deployment pipeline` sets an objective about
  a pipeline — only bare `/goal pause` pauses. `routeGoalArgs` in core,
  10 tests including the critical cases.

### Verified (2026-07-21)

- 104 unit tests, tsc clean.

## [0.7.1] — 2026-07-21

### Changed — `/goal-settings` renamed to `/gla`

One config command for everything — goals, loops, lists, and the auditor —
deserves a name that doesn't say "goal" alone. `/gla` matches the `.pi-gla/`
state directory and sits in its own namespace beside the three verbs
(`/goal`, `/list`, `/loop`). Same handler, same tiers:

```
/gla                          # effective values + provenance
/gla model=provider/id        # write GLOBAL
/gla project tokenlimit=500   # write project override
```

`/goal-settings` is gone (renamed, not aliased — the plugin is a day old;
clean break over surface creep).

## [0.7.0] — 2026-07-21

### Added — global config tier

- **One global config, rarely opened.** Settings now resolve per key as
  **project > global > defaults**: global lives at
  `~/.pi/agent/pi-goal-loop-audit.settings.json`, the project override stays
  at `.pi-gla/settings.json`. `/goal-settings key=value` writes GLOBAL by
  default (set the auditor override, notify command, token limit once — not
  in every project); `/goal-settings project key=value` writes the rare local
  override; `key=unset` removes the key from that tier.
- **Provenance display**: bare `/goal-settings` shows every effective value
  with its source (`[project]` / `[global]` / `[default]`) and both file paths.
- Nothing is per-goal: model, thinking, notify, and token budget are shared
  config for all three loops. The auditor still defaults to the pi session
  model — the plugin never picks a model.
- `mergeSettings` in core (4 unit tests): later layers win per key,
  `undefined` means "not set here", base never mutated.

### Verified (2026-07-21)

- Live: global write lands at `~/.pi/agent/…` with quoted `$1` commands intact;
  `project` prefix writes only the project file; provenance display correct.
- `loop` smoke green with project-scoped notify (no global-config leak).
- 94 unit tests, tsc clean.

## [0.6.2] — 2026-07-20

### Changed (model philosophy: the user selects the model in pi)

- **The plugin no longer picks or recommends auditor models.** The auditor
  uses the pi session model by default; `/goal-settings model=provider/id`
  remains as an explicit override. An earlier tier-based auto-selection idea
  was implemented and then ripped out the same day — model choice belongs to
  the user, not the plugin.
- **No model names anywhere**: docs, examples, comments, and messages use
  `provider/model-id` placeholders only. The session-start warning for
  extension-registered providers now explains the two fixes (switch pi's
  model to a built-in provider, or set the override) instead of recommending
  a specific model.
- The smoke harness no longer configures an auditor model at all — the
  auditor shares the test session's pi-selected model, which is the path
  most users will run.

### Verified (2026-07-20)

- `goal` smoke 5/5 with zero auditor-model configuration (auditor ran on the
  session model directly). 90 unit tests, tsc clean.

## [0.6.1] — 2026-07-20

### Fixed (footguns found by real use)

- **Direct `/loop start` refuses a no-number baseline.** Previously a broken
  measure started with a null baseline and burned stall iterations until
  plateau. Now it fails fast with the raw output and a fix hint; `force=1`
  overrides for measures that only work after the agent builds something first.
- **Redirect guidance for non-numeric goals**: `/loop start` parse errors and
  the refusal now say plainly — research/docs/features belong in `/goal` (the
  auditor verifies semantically); `/loop` only believes a number. The loop
  drafting prompt has the same rule and offers to hand over a well-structured
  `/goal` objective instead of inventing a fake metric.

## [0.6.0] — 2026-07-20

Draft everything. For a long-running thing, a draft up front is better —
until now only `/goal` had drafting; `/list add` took raw strings, and
`/loop start` demanded a correct target+measure+direction in one blind shot.

### Added

- **`/loop` drafting with measure test-run** (centerpiece): `/loop` with no
  args starts a grilling turn about target + metric. When the agent calls
  `propose_loop_draft`, the **orchestrator runs the proposed measure command
  once** and shows the real output + parsed number in the Confirm dialog —
  you validate the metric before a single iteration burns tokens. A measure
  producing no number is auto-rejected back to the agent with its own output.
- **`/list` drafting**: `/list add` with no args runs the same goal-drafting
  flow, but the confirmed contract lands in the **queue** (auto-activates if
  nothing is running). Drafting target is now unified: `goal | list | loop`.
- **`/goals` archive browser**: newest-first list of archived goals with
  status, objective head, and stop reason.

### Changed

- `/loop` with no args now drafts; `/loop status` is the explicit status path.

### Verified live (2026-07-20)

- Loop drafting: agent found `num.txt` itself, proposed `cat num.txt`, dialog
  showed "Test-run output: 10 · Parsed number: 10 (lower is better)";
  confirmed loop ran 10→9→8 improving.
- List drafting: confirmed contract → `list_added` → auto-activated →
  worked → audited → archived.
- `/goals` parsing verified against real archive entries.
- 89 unit tests green; `tsc --noEmit` clean.

## [0.5.0] — 2026-07-20

Self-sufficiency release: the loop now owns its own liveness. A goal loop that
dies silently after compaction and needs an external plugin to restart it is a
hole in THIS plugin — so the watchdog is baked in, and the external one
(`@badliveware/pi-compaction-continue`) can be cut.

### Added

- **Heartbeat self-watchdog**: a 15s interval checks the one precise stall
  condition — supervising (active goal or running loop) + session idle + no
  continuation/loop timer scheduled + no activity for 60s — and re-fires the
  continuation itself. Covers every stall cause (compaction-eaten turn,
  dropped message, stale ctx) with a single check. Stall accounting: a
  supervising turn with zero tool calls is a nudge; 3 consecutive nudges
  pause the goal / stop the loop with a clear reason. Pure decision functions
  in `goal-loop-backoff.ts`, 8 unit tests.
- **`/goal-tweak "<new objective>"`** — edit the active goal in place; Confirm
  dialog shows current vs new; the verification contract is re-extracted from
  the new text (old contract dropped if the new text carries none).
- **Structured drafting forms**: the drafting prompt now prefers
  `ask_user_question` (from `rpiv-ask-user-question`) when the tool is
  available in the session — structured option lists during grilling without
  a hard dependency. Plain conversation remains the fallback.

### Verified (2026-07-20)

- 89 unit tests green; `tsc --noEmit` clean.
- `goal` smoke 5/5 with the heartbeat interval live through the full cycle.

## [0.4.0] — 2026-07-20

The completion release: the last open pi-goal-x flaw is closed, and every
deferral from earlier milestones either shipped or was recorded as rejected.

### Added

- **Auditor compaction** (closes flaw #3, the final one): pi's built-in
  compaction is now enabled in the auditor session (was disabled — long audits
  could exhaust context mid-audit). Safety is structural: regression_shield is
  orchestrator-side, so compaction can only weaken the auditor's evidence and
  cause disapproval, never a false approval.
- **Token guard**: goals now track real token usage (summed from assistant
  `usage.totalTokens`, deduped across replayed `agent_end` history). Crossing
  the limit pauses the goal with a clear reason. Default 1M per goal;
  `/goal-settings tokenlimit=<n>` to tune. Shown in `/goal-status`.
- **Loop 3 `branch=1` mode**: all loop work on a scratch branch
  (`pi-gla-loop/<timestamp>-<slug>`) — commit per improvement,
  `git reset --hard` per regression (scratch branch only; your branch and
  uncommitted work are never touched). Refuses non-git dirs and dirty trees.
  On stop: returns to your original branch with merge instructions.
- **Resumption notice** on `session_start`: active goal (with queue depth) or
  running loop (iteration/best/stall) is announced. (Replaces the D4
  "plugin vanished" self-check, which is impossible from inside the plugin —
  absent code cannot run. Recorded as rejected in PLAN.md.)

### Fixed / synced

- `schemas/goal.schema.json` updated to the current state shape (was v0.1.0,
  still said "oracle").
- `examples/example-objective.md` rewritten — it still used `/pi-gla-set`.
- `docs/DESIGN.md` addenda for v0.2.0/v0.3.0/v0.4.0.
- Smoke harness: new `draft-reject` scenario (Confirm → No → refine → Yes →\n  audited approval, 6/6); clarified-word probe made robust (a grilling turn
  ends with `?`).

### Verified live (2026-07-20, `scripts/smoke.sh`)

- `goal` 5/5 (with compaction enabled), `list` 4/4, `loop` 5/5, `draft` 3/3,
  `draft-reject` 6/6.
- branch=1 smoke: 5 commits (one per improving iteration) on the scratch
  branch, zero for stalls, `main` untouched, returned to `main` on plateau
  stop with merge instructions.
- 81 unit tests green; `tsc --noEmit` clean.

## [0.3.0] — 2026-07-20

The third loop. All three loops now ship on one state machine.

### Added

- **Loop 3: `/loop`** — metric-driven forever loop:
  `/loop start "<target>" measure="<cmd>" direction=min|max [window=5] [max=50]`,
  `/loop status`, `/loop stop`. The **orchestrator** runs the measure command
  after every agent turn (the agent never self-reports) and stops on plateau
  (`window` consecutive non-improving iterations), iteration cap, or
  `/loop stop`. This is the anti-doorknob design: the loop only believes a
  number. No auditor in loop 3 — the metric is the verdict. Pure logic in
  `extensions/goal-loop-forever.ts` (22 unit tests).
- **`propose_task_list` tool** — the agent can break a goal into milestones
  after a Confirm dialog. Anti-drift caps: 20 top-level tasks,
  **5 subtasks per task** (pi-goal-x flaw #4). Validation/ids in core,
  8 unit tests. Makes the existing `complete_task` / `update_task_status`
  tools actually usable.
- **`notify=<cmd>` setting** — config-gated push: shells out on goal complete,
  goal pause, and loop stop; message passed as `$1`.
  `/goal-settings notify='echo $1 >> /tmp/log'` — the settings parser is now
  quote-aware (a naive whitespace split mangled quoted commands to `"'echo"`).

### Fixed

- `/goal-settings` key=value parsing handles quoted values with spaces.
- Smoke harness is hermetic: all scenarios run under a bare
  `PI_CODING_AGENT_DIR` with a readiness wait — global extensions (including
  older npm installs of this package) can no longer collide with the dev
  build under test, and commands can't race the REPL into the agent.

### Verified live (2026-07-20, `scripts/smoke.sh`)

- `goal`: 5/5 — auditor approval, shield, archive.
- `list`: 4/4 — two queued items auto-advanced through audit, queue drained.
- `loop`: 5/5 — metric 5→0 with per-iteration stall accounting, plateau stop
  at window, `loop_stopped` in ledger, notify fired.
- `draft`: 3/3 — grill → Confirm dialog → audited approval.

## [0.2.0] — 2026-07-20

Second loop, the anti-bamboozle hardening, and drafting.

### Added

- **Loop 2: `/list`** — queue of goals: `/list add|show|next|remove <n>|clear`.
  Each item is a full goal (objective + verification contract). Completing or
  aborting a list-sourced goal auto-activates the next queued item; a session
  restart with a non-empty queue resumes automatically.
- **regression_shield** — when a goal has a verification contract, the auditor
  MUST produce an `<evidence>` block quoting raw tool output per contract item;
  the orchestrator converts `<approved/>` without complete evidence into a
  disapproval. Kills the "auditor ran `bash true` and approved" hole that
  pi-goal-x's author documented as unfixable-cheaply. Pure logic lives in
  `extensions/goal-loop-shield.ts` (dependency-free, fully unit-tested).
- **Drafting** — `/goal` with no args starts a clarification turn; the agent
  grills one focused question at a time, then `propose_goal_draft` opens a
  real Confirm dialog (Yes/No). Nothing activates before confirmation.
  `/goal "<objective>"` still skips drafting.
- **Escape dialog** — aborting the auditor (Esc) now asks: complete WITHOUT
  audit (user takes verification responsibility) or continue working.
- **Provider warning** — at `session_start`, if no auditor model is configured
  and the session model's provider is not a confirmed built-in, warn once with
  the exact `/goal-settings` fix.
- **Inline contract extraction** — one-liner objectives like
  `Create x.txt. Done when: grep -q ok x.txt` now extract the contract
  (previously only line-start markers worked, silently skipping the shield).
- **Integration harness** — `scripts/smoke.sh [goal|list|draft]` drives a real
  pi session in tmux and asserts on the ledger.

### Fixed

- State functions (`setGoal`/`archiveCurrentGoal`) no longer wipe the queue.
- `readState` restores `list` from the ledger; v0.1.0 ledgers upgrade cleanly.

### Verified live (2026-07-20)

- `/list`: two queued items auto-advanced through work → auditor → archive.
- regression_shield: auditor produced a verbatim `<evidence>` block;
  `shield=True` recorded in history.
- Drafting: grill → sharpened contract → Confirm dialog → audited completion.
- Provider warning fired exactly once on a kilocode session.
- `scripts/smoke.sh goal`: 5/5 assertions.

## [0.1.0] — 2026-07-20

First live-verified release. Everything in alpha.1, plus the fixes found by
running the loop end-to-end in a real pi session.

### Fixed (all found by live smoke testing)

- **Stale-ctx crash**: timers captured `ExtensionContext` which throws after
  session replacement. All timers now read a `lastCtx` refreshed by every
  event/command handler; stale ctx is detected and dropped safely.
- **API surface**: imports moved to the public entrypoint
  (`@earendil-works/pi-coding-agent`) with `Model` from `pi-ai` and
  `ThinkingLevel` from `pi-agent-core`. `sendMessage` is called on the `pi`
  API object, not `ExtensionContext`.
- **Tool contract**: tool results include `details`; command handlers are
  async; the tool event is `tool_call` (not `before_tool_call`).
- **Auditor "no model" failure**: auditor now defaults to `ctx.model` when no
  auditor model is configured, matching pi-goal-x's `resolveAuditorModel`.
- **Auditor model setting works**: `/goal-settings model=provider/id` resolves
  through the model registry (was a placeholder storing an unresolved id).
- **Audit-history pollution**: only non-empty auditor reports are recorded as
  verdicts (infrastructure failures surface via `pauseReason` instead);
  history capped at 20 entries; entries now carry an `error` field.
- **Objective quoting**: `/goal "..."` strips one layer of surrounding quotes.

### Added

- **Command-collision detection** (`warnOnCommandCollision`): pi never throws
  on duplicate command names (first registrant keeps the bare name, later ones
  get `:2`), so we detect duplicates at `session_start` and warn once.
- **Built-in-provider rule documented**: the auditor session has no extensions,
  so it can only use built-in providers. `/goal-settings` warns on save;
  INSTALL.md shows how to verify a model works extension-less.

### Verified live (2026-07-20)

- Full loop: `/goal` → agent works → `complete_goal` → isolated auditor
  (extension-less session, separate model) approves → archived with clean
  1-entry history and a real evidence-based auditor report.
- 5-consecutive-error auto-pause (triggered by a live provider 403 storm).
- Esc during audit: aborts the pi turn; loop recovers via `agent_end`.
  (pi-goal-x's Escape dialog is v0.2.0 scope.)

## [0.1.0-alpha.1] — 2026-07-19

### Added

- **Loop 1 (single goal)**: single ordered goal with isolated auditor.
  - `/goal "<objective>"` — bypass drafting, start now.
  - `/pi-gla-status` — show state + iteration counter + audit history.
  - `/pi-gla-pause` — pause with reason.
  - `/pi-gla-resume` — resume.
  - `/pi-gla-cancel` — abort + archive.
  - `/goaltings` — configure auditor model + thinking level.
  - `complete_goal` tool — spawns isolated auditor.
  - `pause_goal` tool — pause with reason.
  - `complete_task` tool — task tracking helper.
  - `update_task_status` tool — task tracking helper.
- **Isolated auditor** (`goal-loop-auditor.ts`): runs in fresh session, no extensions, no skills, no prompts, read-only tools.
- **JSONL state** (`.pi-gla/active.jsonl`): every state transition persisted.
- **Markdown goal file** (`.pi-gla/goals/<id>.md`): structured rendering replaces pi-goal-x's hand-concat.
- **Hard 5-min backoff cap** (`goal-loop-backoff.ts`): kills the 1-hour wait pathology.
- **Verification contract extraction**: `Done when:`, `Verify:`, `Verified when:` markers split objective from contract.
- **Schema** (`schemas/goal.schema.json`): JSON Schema for goal state.
- **Test suite**: 14 unit tests across 3 files (`tests/`).
- **Example** (`examples/example-objective.md`): worked walkthrough.

### Not included (deferred)

- Drafting phase with structured Q&A → v0.2.0.
- regression_shield auditor requirement (must include raw output) → v0.2.0.
- Loop 2 (list) → v0.2.0.
- Loop 3 (loop) → v0.3.0.
- Native TUI form widget → v0.2.0.
- Live pi session tests → v0.2.0.
- Telegram push → v0.3.0.

### Architecture notes

We deliberately **fork pi-goal-x 0.19.0** as the architectural basis. We **do not** support interop with `pi-goal-x`'s `.pi/goals/` directory. This is a clean break.

We **copy and adapt** the isolated auditor pattern (it's the architectural part that matters), but reduce the per-loop file count (no per-loop plugin files) and replace the hand-concat markdown renderer with structured JSON.

## [Unreleased] → v0.2.0 plan

- Drafting with structured Q&A (`/pi-gla`).
- regression_shield auditor.
- Native TUI form widget.
- Loop 2 (list).
- Live integration tests.
