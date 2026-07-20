/**
 * pi-goal-loop-audit — v0.1.0
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
