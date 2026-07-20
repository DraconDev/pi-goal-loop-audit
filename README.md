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
| Goal intake | Drafting + structured Q&A + Confirm/Reject dialog (planned v0.2.0) |
| Implementation | `agent_end`-driven continuation loop with 5-minute hard backoff cap |
| Completion | Isolated auditor session; raw command output required per item (planned v0.2.0) |

## Quick start

Install:
```bash
pi install npm:pi-goal-loop-audit
```

Use:
```
/goal "Step 1. Step 2. Done when: tests pass."   # set + start
/goal-status                       # show state
/goal-pause                        # pause
/goal-resume                       # resume
/goal-cancel                       # abort
/goal-settings                     # auditor model + thinking
```

## Three loops on one state machine

| Loop | Command | Status |
|---|---|---|
| 1. Single ordered goal | `/goal "<objective>"` | **v0.1.0** (this release) |
| 2. Queue of goals | `/list add\|show\|clear` | v0.2.0 |
| 3. Forever-polish loop | `/loop start\|stop` | v0.3.0 |

Each loop is a different policy class on the same status machine.

## What this fixes vs. pi-goal-x

| Flaw in pi-goal-x | Fix in pi-goal-loop-audit |
|---|---|
| `detailedSummary` is hand-concat strings | Structured JSON state + native markdown renderer |
| Stuck-counter has no ceiling — 1-hour waits happen | Hard 5-minute backoff cap, fall through to user notification |
| Auditor can't compact — context exhaustion mid-audit | Deterministic compaction; JSONL state for findings (planned v0.2.0) |
| Agent can grow subtasks indefinitely | `max_subtasks_per_task` cap; further requires confirmation |
| Auditor can rubber-stamp after `bash true` | `regression_shield`: raw output required per item (planned v0.2.0) |
| `pause_goal` is fire-and-forget | Live TUI badge + optional push on pause/blocked/auditor events |
| Vague objective + weak auditor = rubber-stamp | Drafting phase + isolated auditor verifies precisely |

## Detailed design

See `docs/DESIGN.md`.

## Installation from source

```bash
git clone https://github.com/DraconDev/pi-goal-loop-audit.git
cd pi-goal-loop-audit
pi install .
```

## License

MIT