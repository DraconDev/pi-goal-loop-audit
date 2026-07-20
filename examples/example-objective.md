# Example: a v0.1.0 objective

This document is a worked example showing the simplest possible goal for
`pi-goal-loop-audit`. Once you `/pi-gla-set` it, the orchestrator creates
state at `.pi-gla/` and starts the loop.

## Set the goal

```
/pi-gla-set "
Step 1. Add a /healthz endpoint to server.ts that returns {status: 'ok'} and HTTP 200.
Step 2. Add a vitest test that hits it.

Done when:
- curl -fsS localhost:3000/healthz returns 200 with body {\"status\":\"ok\"}
- npm test exits 0 with 0 failures
- The test file is committed
"
```

The orchestrator parses the objective, extracts `Done when:` as the
verification contract, and starts the loop. The agent sees:

```
[GOAL CHECKPOINT goalId=...]
Continue working toward the active pi-goal-loop-audit goal.

## Objective
Step 1. ...
Step 2. ...
[+ verification contract]
[+ tasks / next-pending-task]
```

The agent does work. When it calls `complete_goal(...)`, the **isolated auditor** runs.

## What the auditor sees

The auditor is spawned in a fresh pi session with:
- No extensions, no skills, no prompts, no themes.
- Read-only tools: `read`, `grep`, `find`, `ls`, `bash`.
- The same goal markdown and the agent's `completionSummary` / `verificationSummary`.

The auditor inspects:
1. `server.ts` — does the `/healthz` endpoint exist?
2. The test file — does it cover the endpoint?
3. `npm test` exit code — does it pass?
4. Git log — is the test committed?

If all four pass, the auditor emits `<approved/>`. Otherwise `<disapproved/>`.

## What happens on `<approved/>`

The orchestrator archives the goal to `.pi-gla/archive/<id>.md`, sets
`status = "complete"`, writes `stopReason = "auditor <model> approved"`,
and notifies the TUI.

## What happens on `<disapproved/>`

The orchestrator sets `status = "active"` again (the goal is not yet done),
appends the auditor's report to `auditHistory`, sets
`pauseReason = "auditor disapproved"`, schedules the next continuation,
and notifies the agent with the auditor's first 800 chars.

The agent re-reads the auditor's feedback, fixes the gap, and calls
`complete_goal` again — with full context of what was missing.

## When does the goal end "for real"

Only when:
- Auditor `<approved/>` (objective is genuinely satisfied), OR
- User `/pi-gla-cancel` (abort), OR
- User `/pi-gla-pause` + leave it (pause stays).

There is no other termination path. **Hard 5-minute backoff cap** prevents the
1-hour-waits problem pi-goal-x exhibits.

## Edge cases v0.1.0 explicitly handles

1. Vague objective (no `Done when:` clause) — auditor decides based on objective text.
2. Auditor not configured (`/pi-gla-settings`) — defaults to `auditorThinkingLevel=medium`.
3. Empty turn (no tool calls) — does not pause in v0.1.0; auditor catches rubber-stamps.
4. Five consecutive errors — auto-pauses with a clear message.
5. Esc during audit — auto-skip-to-pause, user picks "complete without audit" or "continue".

## Edge cases v0.2.0 will handle

1. Drafting phase — pre-confirmed goal with structured Q&A.
2. regression_shield — auditor must include raw output for every verification item.
3. Native TUI form widget for `goal_questionnaire`.
