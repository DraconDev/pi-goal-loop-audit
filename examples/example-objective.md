# Examples: the three loops

Worked examples for `pi-goal-list-loop-audit`. State lives at `.pi-glla/`
(ledger `active.jsonl`, goal markdown in `goals/`, finished goals in `archive/`).

## Loop 1: `/goal` — single goal with isolated auditor

Direct (skip drafting):

```
/goal start Step 1. Add a /healthz endpoint to server.ts returning {status:'ok'}.
Step 2. Add a vitest test that hits it.
Done when:
- curl -fsS localhost:3000/healthz returns 200 with body {"status":"ok"}
- npm test exits 0 with 0 failures
```

Or drafting (recommended when the idea is still fuzzy):

```
/goal
# the agent grills one focused question at a time, then a Confirm dialog
# shows the objective + Done-when contract. Nothing starts before you confirm.
```

What happens next:

1. The agent works the objective turn by turn (`agent_end`-driven continuation).
   Guards: a stall watchdog (3 consecutive turns with no tool calls), a
   5-consecutive-errors pause, and the optional token guard — no wall-clock
   cap; a goal ends via completion, pause/cancel, or a guard.
2. It calls `complete_goal` when it believes it is done.
3. The **isolated auditor** — a fresh pi session with no extensions and only
   read tools — inspects the repo. Because this goal has a `Done when:`
   contract, the auditor MUST quote raw command output per contract item in an
   `<evidence>` block (regression_shield). An approval without complete
   evidence is automatically converted to a disapproval.
4. Approved → goal archived to `.pi-glla/archive/<id>.md`. Disapproved → the
   loop continues with the auditor's feedback.

Useful commands: `/goal status`, `/goal pause`, `/goal resume`, `/goal cancel`,
`/glla` (auditor model, thinking level, token limit, notify command, autoresume).

## Loop 2: `/list` — the shopping list of goals

```
/list Create one.txt containing one. Done when: grep -q one one.txt
/list Create two.txt containing two. Done when: grep -q two two.txt
/list            # show active + waiting items
/list next       # skip current item
/list remove 2   # drop item 2
/list clear      # empty the list
```

Each item is a full goal with its own contract and audit. When one completes
(or is aborted), the next activates automatically. Order is the default, not
the law — `/list next 3` activates item 3 directly. On session restore the
list HOLDS in a fresh session (nothing auto-starts); it auto-activates only
when you resume a session with history, or when the project sets
`/glla project autoresume=on`.

## Loop 3: `/loop` — metric-driven forever loop

```
/loop start "reduce TODO comments in src" measure="grep -rc TODO src | cut -d: -f2 | paste -sd+ | bc" direction=min window=5 max=50
/loop status     # iteration, best, stall, recent values
/loop stop       # halt with summary
```

The **orchestrator** runs your `measure` command after every agent turn — the
agent never self-reports a number. The loop stops on plateau (`window`
non-improving iterations), the `max` cap, a time/token bound, or `/loop stop`.
There is no completion check in loop 3 — "improve until X" is a GOAL; a loop
is a process. No auditor either: the metric is the verdict.

With `branch=1`, all work happens on a scratch branch
(`pi-glla-loop/<timestamp>-<slug>`): each improvement is committed, each
regression is hard-reset (scratch branch only), and on stop you return to your
original branch with merge instructions. Requires a clean working tree.

## Notifications (optional)

```
/glla notify='echo $1 >> ~/goal-events.log'
```

Fires on goal complete, goal pause, and loop stop; message as `$1`.

## Token guard (opt-in)

Off by default. Set a per-goal budget and crossing it pauses the goal:

```
/glla tokenlimit=2000000
```

## The auditor model rule

The plugin never picks a model: the auditor uses your pi session model, and
you can pin an explicit override once:

```
/glla model=provider/model-id
```

If audits ever error with auth/provider failures, the session-start notice
tells you to set that override — the auditor session has no extensions, so
providers that only exist via an extension may be unavailable to it.
