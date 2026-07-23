/**
 * pi-goal-list-loop-audit — v0.1.0
 * extensions/goal-loop-backoff.ts
 *
 * Hard 5-minute ceiling on backoff. Anything beyond the ceiling pauses the
 * loop and notifies the user (TUI badge + optional push).
 *
 * Design: see docs/DESIGN.md, decision #3.
 */

export const BACKOFF_HARD_CAP_MS = 5 * 60 * 1000;
export const BACKOFF_IDLE_RETRY_MS = 50;     // when adding another iter to queue
export const BACKOFF_ERROR_BASE_MS = 5_000;  // first error retry
export const BACKOFF_ERROR_MAX_MS = 60_000;  // max error retry (separate from stuck cap)

/**
 * Return the backoff (ms) before scheduling the next iteration, based on
 * consecutive iterations that produced no meaningful progress.
 *
 * Caps at BACKOFF_HARD_CAP_MS (5 min). Beyond that, the orchestrator should
 * pause and notify the user.
 */
export function backoffMs(stuckCount: number, mode: "stuck" | "error" | "context" = "stuck"): number {
  if (mode === "error") {
    return Math.min(BACKOFF_ERROR_BASE_MS * 2 ** Math.max(0, stuckCount - 1), BACKOFF_ERROR_MAX_MS);
  }
  if (mode === "context") {
    return Math.min(30_000 * Math.max(1, stuckCount), BACKOFF_HARD_CAP_MS);
  }
  // "stuck" — the main case the user complained about.
  const schedule = [0, 30_000, 60_000, 120_000, 240_000, BACKOFF_HARD_CAP_MS];
  const idx = Math.max(0, Math.min(schedule.length - 1, stuckCount));
  return schedule[idx] ?? BACKOFF_HARD_CAP_MS;
}

/**
 * Determine whether the orchestrator should pause (vs. reschedule).
 *
 * Pause conditions:
 *   - stuck for >= 5 minutes
 *   - any single iteration has been silent (no tool call) for > N seconds
 */
export function shouldPauseAfterBackoff(stuckElapsedMs: number, idleIterCount: number): boolean {
  if (stuckElapsedMs >= BACKOFF_HARD_CAP_MS) return true;
  if (idleIterCount >= 3) return true;
  return false;
}

/**
 * Human-readable label, e.g. "5m", "30s", "1m".
 */
export function humanMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

// =================================================================
// Heartbeat self-watchdog (v0.5.0)
//
// Replaces the external pi-compaction-continue plugin FOR OUR LOOPS. A goal
// loop that dies silently (compaction-eaten turn, dropped message, stale ctx)
// is a hole in this plugin, not something to outsource. One precise check
// covers every stall cause: supervising + idle + nothing scheduled + quiet
// for too long → re-fire the continuation ourselves.
// =================================================================

export const HEARTBEAT_INTERVAL_MS = 15_000;
export const HEARTBEAT_STALL_MS = 60_000;
export const HEARTBEAT_MAX_NUDGES = 3;
/** v0.23.2: default wall-clock wedge threshold — a busy session with no
 * activity for this long is almost always a hung unbounded command
 * (test suite / dev server) holding the whole goal hostage. The
 * turn-based watchdogs are blind to it (it's ONE long turn); only the
 * wall clock sees it. 0 in settings = off.
 * v0.23.3: 45 → 30. The alert is notification-only, so a false positive
 * costs one notification while a false negative costs hours — that
 * asymmetry argues tight. (pi-goal-x, the cautionary tale, had NO wall
 * clock at all: a wedged session was silent forever.) */
export const WEDGE_ALERT_DEFAULT_MINUTES = 30;
/** v0.23.3: hard cap on one measure command. An unbounded measure is the
 * same wedge shape as an unbounded test suite — it freezes the loop tick
 * forever. Timeout → measure failure (null) → stall path → plateau stop,
 * never a silent hang. Matches pi-loop-mode's --check-timeout default. */
export const MEASURE_TIMEOUT_MS = 10 * 60_000;
/** v0.23.3: auditor inactivity abort. The auditor legitimately runs the
 * project's own verification (test suites!), so the bound is on
 * INACTIVITY (no session events at all), not wall time. An auditor with
 * no events for this long is wedged — abort and report an error, never
 * disapprove, never hang the completion gate forever. */
export const AUDITOR_STALL_MS = 10 * 60_000;

export interface WedgeInput {
  /** A goal is active (autoContinue) or a loop is running. */
  supervising: boolean;
  /** Session is BUSY (mid-turn). An idle quiet session is the
   *  heartbeat's job, not the wedge alert's. */
  sessionBusy: boolean;
  /** Milliseconds since the last observed agent activity. */
  silentMs: number;
  /** Milliseconds since the last wedge alert fired (throttle). */
  msSinceLastAlert: number;
  /** Threshold in ms; 0 disables the alert entirely. */
  thresholdMs: number;
}

/** Should the wedge alert fire right now? Alerts at most once per
 *  threshold interval while the wedge persists; any activity re-arms. */
export function shouldWedgeAlert(input: WedgeInput): boolean {
  if (!input.supervising) return false;
  if (!input.sessionBusy) return false;
  if (input.thresholdMs <= 0) return false;
  if (input.silentMs < input.thresholdMs) return false;
  return input.msSinceLastAlert >= input.thresholdMs;
}

export interface HeartbeatInput {
  /** A goal is active (autoContinue) or a loop is running. */
  supervising: boolean;
  /** ctx.isIdle() && !ctx.hasPendingMessages() */
  sessionIdle: boolean;
  /** A continuation or loop timer is already scheduled. */
  timerPending: boolean;
  /** Milliseconds since the last observed agent activity. */
  msSinceActivity: number;
  stallMs?: number;
}

/** Should the heartbeat re-fire the continuation right now? */
export function shouldHeartbeatRefire(input: HeartbeatInput): boolean {
  if (!input.supervising) return false;
  if (!input.sessionIdle) return false;
  if (input.timerPending) return false;
  return input.msSinceActivity >= (input.stallMs ?? HEARTBEAT_STALL_MS);
}

/**
 * Judge a finished turn for nudge accounting. A supervising turn with zero
 * tool calls produced no real progress — that is a nudge. Anything with a
 * tool call resets the counter. Returns the new consecutive-nudge count.
 */
export function accountTurnForNudges(toolCalls: number, currentNudges: number): number {
  return toolCalls > 0 ? 0 : currentNudges + 1;
}
