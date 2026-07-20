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
> /goal-status        # expect: complete, audit history shows 1 approved
cat .pi-gla/active.jsonl | tail -3
ls .pi-gla/archive/   # expect: one .md file
```

### M2 — v0.2.0 (list + drafting + regression_shield)

- [ ] **Loop 2: `/list`** — `add|show|clear|next`; each item is a full goal (objective + contract); completing one auto-starts the next.
- [ ] **Drafting**: `/goal` with no args → structured Q&A → Confirm/Reject dialog before activation. Direct activation only via `/goal "<objective>"`.
- [ ] **regression_shield**: auditor must quote raw command/tool output per verification-contract item; missing evidence → auto-disapprove.
- [ ] `max_subtasks_per_task` cap with confirmation.
- [ ] Live integration test harness (spawn pi headless, assert on `.pi-gla/active.jsonl`).
- [ ] CHANGELOG, tag, publish.

### M3 — v0.3.0 (loop)

- [ ] **Loop 3: `/loop`** — `start|stop`; requires a `measure:` command (numeric metric) and a direction (min/max). Each iteration: run measure → propose change → apply → re-measure → keep or revert. Plateau detection (`plateauWindow`) stops the loop.
- [ ] Push notifications on pause/audit/complete (optional, config-gated).
- [ ] Live tests, CHANGELOG, tag, publish.

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

**Decision**: default = session model (works when the session model is built-in); `/goal-settings model=provider/id` overrides for rigs running extension-provided session models. The `/goal-settings` save message now warns about the built-in-provider constraint. `resolveAuditorModel` documents it in code. v0.2.0 should add a startup check: if session model's provider is extension-registered and no auditorModel is set, warn once.

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
