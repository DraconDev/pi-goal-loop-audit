/**
 * pi-goal-loop-audit — v0.3.0
 * extensions/goal-loop-forever.ts
 *
 * Loop 3 core: metric parsing, improvement comparison, plateau detection.
 * Pure + dependency-free so unit tests can exercise it under plain node.
 *
 * Design rule (the anti-doorknob law): the loop only believes a number.
 * The orchestrator runs the user's measure command; the agent never
 * self-reports progress.
 */

export type LoopDirection = "min" | "max";

export interface LoopMeasure {
  iteration: number;
  value: number | null;
  improved: boolean;
  at: string;
}

export interface LoopState {
  target: string;
  measureCmd: string;
  direction: LoopDirection;
  iteration: number;
  maxIterations: number;
  plateauWindow: number;
  stallCount: number;
  bestValue: number | null;
  lastValue: number | null;
  active: boolean;
  stopReason?: string;
  history: LoopMeasure[];
  startedAt: string;
  /** branch=1 mode: scratch branch holding the loop's commits. */
  branchName?: string;
  /** branch=1 mode: the branch to return to on stop. */
  originalBranch?: string;
}

/** Scratch-branch name for branch=1 mode. Format pinned by tests. */
export function loopBranchName(startedAtIso: string, target: string): string {
  const stamp = startedAtIso.replace(/[^0-9]/g, "").slice(0, 14);
  const slug = target.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || "loop";
  return `pi-gla-loop/${stamp}-${slug}`;
}

export const LOOP_DEFAULTS = {
  maxIterations: 50,
  plateauWindow: 5,
};

/**
 * Parse the first number in measure-command output. Accepts integers,
 * decimals, negatives, and scientific notation; ignores surrounding text
 * (e.g. "score: 42" → 42). Returns null when no number is present — a
 * broken measure is a stall, never a crash.
 */
export function parseMetric(output: string): number | null {
  const m = output.match(/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/);
  if (!m) return null;
  const n = Number.parseFloat(m[0]!);
  return Number.isFinite(n) ? n : null;
}

/** Did `value` improve on `best` for this direction? First value is always a baseline. */
export function isImprovement(direction: LoopDirection, value: number, best: number | null): boolean {
  if (best === null) return true;
  return direction === "min" ? value < best : value > best;
}

export type LoopTickOutcome =
  | { kind: "continue"; improved: boolean; value: number | null }
  | { kind: "stop"; reason: string };

/**
 * Apply one measurement to the loop state (mutates + returns the outcome).
 * Stop rules, in order: plateau (stall >= window), iteration cap.
 */
export function applyMeasurement(loop: LoopState, value: number | null, at: string): LoopTickOutcome {
  loop.iteration++;
  const improved = value !== null && isImprovement(loop.direction, value, loop.bestValue);
  if (value === null) {
    loop.stallCount++;
  } else if (improved) {
    loop.bestValue = value;
    loop.stallCount = 0;
  } else {
    loop.stallCount++;
  }
  loop.lastValue = value;
  loop.history.push({ iteration: loop.iteration, value, improved, at });
  if (loop.history.length > 200) loop.history.splice(0, loop.history.length - 200);

  if (loop.stallCount >= loop.plateauWindow) {
    loop.active = false;
    loop.stopReason = `plateau — no improvement in ${loop.plateauWindow} consecutive iterations (best: ${loop.bestValue ?? "n/a"})`;
    return { kind: "stop", reason: loop.stopReason };
  }
  if (loop.iteration >= loop.maxIterations) {
    loop.active = false;
    loop.stopReason = `max iterations reached (${loop.maxIterations}); best: ${loop.bestValue ?? "n/a"}`;
    return { kind: "stop", reason: loop.stopReason };
  }
  return { kind: "continue", improved, value };
}

/** Parse `/loop start` args into a config. Throws on missing pieces. */
export function parseLoopStartArgs(raw: string): {
  target: string;
  measureCmd: string;
  direction: LoopDirection;
  plateauWindow: number;
  maxIterations: number;
  branch: boolean;
  force: boolean;
} {
  // Key=value pairs first (measure= and direction= may hold quoted values),
  // the remaining text is the target.
  let rest = raw.trim();
  const kv = new Map<string, string>();
  const kvRe = /(\w+)=(?:"([^"]*)"|'([^']*)'|(\S+))/g;
  let m: RegExpExecArray | null;
  const spans: Array<[number, number]> = [];
  while ((m = kvRe.exec(rest)) !== null) {
    kv.set(m[1]!.toLowerCase(), m[2] ?? m[3] ?? m[4] ?? "");
    spans.push([m.index, m.index + m[0].length]);
  }
  // Remove kv spans from the target text.
  let target = "";
  let cursor = 0;
  for (const [s, e] of spans) {
    target += rest.slice(cursor, s);
    cursor = e;
  }
  target += rest.slice(cursor);
  target = target.trim().replace(/^["']|["']$/g, "").trim();

  const measureCmd = kv.get("measure") ?? "";
  if (!measureCmd) throw new Error('missing measure="<shell command that prints a number>"');
  const dirRaw = (kv.get("direction") ?? "").toLowerCase();
  if (dirRaw !== "min" && dirRaw !== "max") throw new Error("missing direction=min|max");
  if (!target) throw new Error("missing target (what to improve), e.g. /loop start \"reduce test failures\" measure=\"...\" direction=min");

  const window = Number.parseInt(kv.get("window") ?? "", 10);
  const max = Number.parseInt(kv.get("max") ?? "", 10);
  const branchRaw = (kv.get("branch") ?? "").toLowerCase();
  const forceRaw = (kv.get("force") ?? "").toLowerCase();
  return {
    target,
    measureCmd,
    direction: dirRaw,
    plateauWindow: Number.isFinite(window) && window > 0 ? window : LOOP_DEFAULTS.plateauWindow,
    maxIterations: Number.isFinite(max) && max > 0 ? max : LOOP_DEFAULTS.maxIterations,
    branch: branchRaw === "1" || branchRaw === "true" || branchRaw === "yes",
    force: forceRaw === "1" || forceRaw === "true" || forceRaw === "yes",
  };
}
