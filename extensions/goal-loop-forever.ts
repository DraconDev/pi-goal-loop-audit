/**
 * pi-goal-list-loop-audit — v0.3.0
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

export interface LoopRefinement {
  at: string;
  iteration: number;
  oldTarget: string;
  newTarget: string;
  oldMeasureCmd: string;
  newMeasureCmd: string;
}

export interface LoopState {
  target: string;
  /** v0.23.0: optional — a metricless "spec loop" (measure=none) has no
   * metric, no direction, and NO plateau stop; it ends only at max/time/
   * tokens bounds or /loop stop. */
  measureCmd?: string;
  direction?: LoopDirection;
  iteration: number;
  /** v0.23.0: 0 = unbounded (no iteration cap). Default 50. */
  maxIterations: number;
  plateauWindow: number;
  stallCount: number;
  bestValue: number | null;
  lastValue: number | null;
  active: boolean;
  stopReason?: string;
  history: LoopMeasure[];
  startedAt: string;
  /** v0.15.0: arbitrary bounds (never "completion") — stop after this many hours. */
  timeLimitHours?: number;
  /** v0.15.0: arbitrary bounds — stop after this many tokens (input+output). */
  tokenBudget?: number;
  /** v0.15.0: accumulated loop tokens (input+output), orchestrator-counted. */
  tokensUsed?: number;
  /** v0.15.0: living spec — user-confirmed target/measure refinements. */
  refinements?: LoopRefinement[];
  /** branch=1 mode: scratch branch holding the loop's commits. */
  branchName?: string;
  /** branch=1 mode: the branch to return to on stop. */
  originalBranch?: string;
}

/** Scratch-branch name for branch=1 mode. Format pinned by tests. */
export function loopBranchName(startedAtIso: string, target: string): string {
  const stamp = startedAtIso.replace(/[^0-9]/g, "").slice(0, 14);
  const slug = target.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || "loop";
  return `pi-glla-loop/${stamp}-${slug}`;
}

export const LOOP_DEFAULTS = {
  maxIterations: 50,
  plateauWindow: 5,
};

/**
 * Apply a user-confirmed spec refinement (v0.15.0, propose_loop_refine).
 * The loop is a process against a LIVING spec: target/measure may be
 * sharpened mid-run. History keeps both eras via `refinements`. When the
 * measure changes, the old best/last values are a different scale — the
 * caller re-baselines with a fresh measurement and stall state resets.
 */
export function applyRefinement(
  loop: LoopState,
  refinement: LoopRefinement,
  newBaseline: number | null,
): void {
  loop.refinements = loop.refinements ?? [];
  loop.refinements.push(refinement);
  loop.target = refinement.newTarget;
  const measureChanged = refinement.newMeasureCmd !== refinement.oldMeasureCmd;
  loop.measureCmd = refinement.newMeasureCmd;
  if (measureChanged) {
    loop.bestValue = newBaseline;
    loop.lastValue = newBaseline;
    loop.stallCount = 0;
  }
}

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
 * v0.15.0: a loop NEVER checks for completion — there is no done=. Stop
 * rules, in order: time bound, token bound, plateau (stall >= window),
 * iteration cap. All four are arbitrary ends; the metric only judges
 * movement, never arrival.
 */
export function applyMeasurement(loop: LoopState, value: number | null, at: string): LoopTickOutcome {
  loop.iteration++;
  const improved = value !== null && loop.direction !== undefined && isImprovement(loop.direction, value, loop.bestValue);
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

  if (loop.timeLimitHours !== undefined) {
    const elapsedH = (Date.parse(at) - Date.parse(loop.startedAt)) / 3_600_000;
    if (Number.isFinite(elapsedH) && elapsedH >= loop.timeLimitHours) {
      loop.active = false;
      loop.stopReason = `time bound reached (${loop.timeLimitHours}h); best: ${loop.bestValue ?? "n/a"}`;
      return { kind: "stop", reason: loop.stopReason };
    }
  }
  if (loop.tokenBudget !== undefined && (loop.tokensUsed ?? 0) >= loop.tokenBudget) {
    loop.active = false;
    loop.stopReason = `token budget exhausted (${(loop.tokensUsed ?? 0).toLocaleString()} >= ${loop.tokenBudget.toLocaleString()}); best: ${loop.bestValue ?? "n/a"}`;
    return { kind: "stop", reason: loop.stopReason };
  }
  if (loop.stallCount >= loop.plateauWindow) {
    loop.active = false;
    loop.stopReason = `plateau — no improvement in ${loop.plateauWindow} consecutive iterations (best: ${loop.bestValue ?? "n/a"})`;
    return { kind: "stop", reason: loop.stopReason };
  }
  if (loop.maxIterations > 0 && loop.iteration >= loop.maxIterations) {
    loop.active = false;
    loop.stopReason = `max iterations reached (${loop.maxIterations}); best: ${loop.bestValue ?? "n/a"}`;
    return { kind: "stop", reason: loop.stopReason };
  }
  return { kind: "continue", improved, value };
}

/**
 * One iteration of a METRICLESS loop (v0.23.0, measure=none). There is no
 * number to judge movement, so there is no plateau — the loop ends only at
 * the time/token/iteration bounds or /loop stop. This is the Sisyphus mode:
 * work the spec until the bounds say stop. The doorknob risk is real and
 * accepted by the user explicitly; the iteration prompt demands one real,
 * inspectable change per turn.
 */
export function applyMetriclessTick(loop: LoopState, at: string): LoopTickOutcome {
  loop.iteration++;
  loop.history.push({ iteration: loop.iteration, value: null, improved: false, at });
  if (loop.history.length > 200) loop.history.splice(0, loop.history.length - 200);

  if (loop.timeLimitHours !== undefined) {
    const elapsedH = (Date.parse(at) - Date.parse(loop.startedAt)) / 3_600_000;
    if (Number.isFinite(elapsedH) && elapsedH >= loop.timeLimitHours) {
      loop.active = false;
      loop.stopReason = `time bound reached (${loop.timeLimitHours}h) after ${loop.iteration} iterations`;
      return { kind: "stop", reason: loop.stopReason };
    }
  }
  if (loop.tokenBudget !== undefined && (loop.tokensUsed ?? 0) >= loop.tokenBudget) {
    loop.active = false;
    loop.stopReason = `token budget exhausted (${(loop.tokensUsed ?? 0).toLocaleString()} >= ${loop.tokenBudget.toLocaleString()}) after ${loop.iteration} iterations`;
    return { kind: "stop", reason: loop.stopReason };
  }
  if (loop.maxIterations > 0 && loop.iteration >= loop.maxIterations) {
    loop.active = false;
    loop.stopReason = `max iterations reached (${loop.maxIterations})`;
    return { kind: "stop", reason: loop.stopReason };
  }
  return { kind: "continue", improved: false, value: null };
}

/** Parse `/loop start` args into a config. Throws on missing pieces. */
export function parseLoopStartArgs(raw: string): {
  target: string;
  measureCmd: string;
  direction?: LoopDirection;
  plateauWindow: number;
  maxIterations: number;
  branch: boolean;
  force: boolean;
  timeLimitHours?: number;
  tokenBudget?: number;
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

  const measureRaw = (kv.get("measure") ?? "").trim();
  // v0.23.0: measure=none → metricless "spec loop" (Sisyphus mode). No
  // metric, no direction, no plateau — bounds and /loop stop only.
  const metricless = measureRaw.toLowerCase() === "none";
  if (!measureRaw) throw new Error('missing measure="<shell command that prints a number>" (or measure=none for a metricless spec loop — no plateau, ends only at bounds or /loop stop)');
  const dirRaw = (kv.get("direction") ?? "").toLowerCase();
  if (metricless && dirRaw) throw new Error("direction= is meaningless with measure=none — there is no metric to have a direction");
  if (!metricless && dirRaw !== "min" && dirRaw !== "max") throw new Error("missing direction=min|max");
  if (!target) throw new Error("missing target (what to improve), e.g. /loop start \"reduce test failures\" measure=\"...\" direction=min");

  const window = Number.parseInt(kv.get("window") ?? "", 10);
  const max = Number.parseInt(kv.get("max") ?? "", 10);
  const branchRaw = (kv.get("branch") ?? "").toLowerCase();
  const forceRaw = (kv.get("force") ?? "").toLowerCase();
  // v0.15.0: done= is removed — a loop never checks for completion. Teach.
  if (kv.has("done")) {
    throw new Error(
      'done= was removed in v0.15.0 — "improve until X" is a GOAL, not a loop. ' +
      'Use /goal "<target>. Done when: <checkable criterion>" (the auditor verifies it). ' +
      "A loop is a process: it runs until /loop stop, plateau, max= iterations, time= hours, or tokens= budget.",
    );
  }
  const timeRaw = Number.parseFloat(kv.get("time") ?? "");
  const tokensRaw = Number.parseInt(kv.get("tokens") ?? "", 10);
  return {
    target,
    measureCmd: metricless ? "" : measureRaw,
    direction: metricless ? undefined : dirRaw as LoopDirection,
    plateauWindow: Number.isFinite(window) && window > 0 ? window : LOOP_DEFAULTS.plateauWindow,
    // v0.23.0: max=0 = truly unbounded (no iteration cap); absent = 50.
    maxIterations: kv.has("max") ? (Number.isFinite(max) && max >= 0 ? max : LOOP_DEFAULTS.maxIterations) : LOOP_DEFAULTS.maxIterations,
    branch: branchRaw === "1" || branchRaw === "true" || branchRaw === "yes",
    force: forceRaw === "1" || forceRaw === "true" || forceRaw === "yes",
    timeLimitHours: Number.isFinite(timeRaw) && timeRaw > 0 ? timeRaw : undefined,
    tokenBudget: Number.isFinite(tokensRaw) && tokensRaw > 0 ? tokensRaw : undefined,
  };
}
