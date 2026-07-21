# Examples: the three loops

Worked examples for `pi-goal-list-loop-audit` v0.4.0. State lives at `.pi-gla/`
(ledger `active.jsonl`, goal markdown in `goals/`, finished goals in `archive/`).

## Loop 1: `/goal` — single goal with isolated auditor

Direct (skip drafting):

```
/goal "Step 1. Add a /healthz endpoint to server.ts returning {status:'ok'}.
Step 2. Add a vitest test that hits it.
Done when:
- curl -fsS localhost:3000/healthz returns 200 with body {\"status\":\"ok\"}
- npm test exits 0 with 0 failures"
```

Or drafting (recommended when the idea is still fuzzy):

```
/goal
# the agent grills one focused question at a time, then a Confirm dialog
# shows the objective + Done-when contract. Nothing starts before you confirm.
```

What happens next:

1. The agent works the objective turn by turn (`agent_end`-driven continuation,
   5-minute hard backoff cap).
2. It calls `complete_goal` when it believes it is done.
3. The **isolated auditor** — a fresh pi session with no extensions and only
   read tools — inspects the repo. Because this goal has a `Done when:`
   contract, the auditor MUST quote raw command output per contract item in an
   `<evidence>` block (regression_shield). An approval without complete
   evidence is automatically converted to a disapproval.
4. Approved → goal archived to `.pi-gla/archive/<id>.md`. Disapproved → the
   loop continues with the auditor's feedback.

Useful commands: `/goal status`, `/goal pause`, `/goal resume`, `/goal cancel`,
`/gla` (auditor model, thinking level, token limit, notify command).

## Loop 2: `/list` — queue of goals

```
/list add "Create one.txt containing one. Done when: grep -q one one.txt"
/list add "Create two.txt containing two. Done when: grep -q two two.txt"
/list            # show active + queue
/list next       # skip current item
/list remove 2   # drop queue item 2
/list clear      # empty the queue
```

Each item is a full goal with its own contract and audit. When one completes
(or is aborted), the next activates automatically. A restarted session resumes
a non-empty queue on its own.

## Loop 3: `/loop` — metric-driven forever loop

```
/loop start "reduce TODO comments in src" measure="grep -rc TODO src | cut -d: -f2 | paste -sd+ | bc" direction=min window=5 max=50
/loop status     # iteration, best, stall, recent values
/loop stop       # halt with summary
```

The **orchestrator** runs your `measure` command after every agent turn — the
agent never self-reports a number. The loop stops on plateau (`window`
non-improving iterations), the `max` cap, or `/loop stop`. There is no auditor
in loop 3: the metric is the verdict.

With `branch=1`, all work happens on a scratch branch
(`pi-gla-loop/<timestamp>-<slug>`): each improvement is committed, each
regression is hard-reset (scratch branch only), and on stop you return to your
original branch with merge instructions. Requires a clean working tree.

## Notifications (optional)

```
/gla notify='echo $1 >> ~/goal-events.log'
```

Fires on goal complete, goal pause, and loop stop; message as `$1`.

## Token guard

Every goal tracks real token usage (summed from assistant messages).
Crossing the limit pauses the goal:

```
/gla tokenlimit=2000000
```

## The built-in-provider rule (auditor model)

The auditor runs in an **extension-less** session, so it can only use
built-in providers. You select the model in pi; the auditor uses the same
session model — the plugin never picks one itself. If your session provider
is extension-registered, the session-start warning tells you audits will
fail and offers the two fixes: switch pi's model to a built-in provider, or
set an explicit override:

```
/gla model=provider/model-id
```
