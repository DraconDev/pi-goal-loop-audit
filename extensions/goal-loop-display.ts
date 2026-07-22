/**
 * pi-goal-list-loop-audit — v0.9.0
 * extensions/goal-loop-display.ts
 *
 * Pure display builders for the live TUI (status line + above-editor widget).
 * No pi imports — unit tests exercise these directly. The orchestrator calls
 * ctx.ui.setStatus/setWidget with whatever these return.
 */

import type { Goal, State } from "./goal-loop-core.js";
import type { LoopState } from "./goal-loop-forever.js";

// ---- formatters ----

export function fmtElapsed(ms: number): string {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}

export function fmtTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 100_000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, Math.max(0, max - 1)) + "…";
}

function sinceIso(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Date.now() - t : 0;
}

// ---- status line (one-liner, always-on) ----

export interface AuditDisplayProgress {
  currentTool?: string;
  label?: string;
  elapsedMs?: number;
}

/**
 * One-line status for ctx.ui.setStatus("pi-glla", …).
 * Returns undefined when nothing is being supervised (clears the segment).
 */
export function buildStatusText(state: State, audit?: AuditDisplayProgress | null, now = Date.now()): string | undefined {
  if (state.loop?.active) {
    const l = state.loop;
    const arrow = l.direction === "min" ? "↓" : "↑";
    return `glla: loop ${arrow} iter ${l.iteration}/${l.maxIterations} · best ${l.bestValue ?? "n/a"} · stall ${l.stallCount}/${l.plateauWindow}`;
  }
  const g = state.goal;
  if (!g) return undefined;
  if (g.status === "auditing") {
    const tool = audit?.currentTool ? ` · ${audit.currentTool}` : "";
    return `glla: auditing…${tool}`;
  }
  if (g.status === "paused") {
    return `glla: paused ⏸ ${truncate(g.pauseReason ?? "", 40)}`;
  }
  if (g.status === "active") {
    const queue = state.list?.length ? ` · list ${state.list.length}` : "";
    const tasks = g.taskList ? ` ${countDone(g)}/${countTotal(g)} tasks ·` : "";
    return `glla: ${g.policy} ●${tasks} ${fmtElapsed(now - Date.parse(g.createdAt))}${queue}`;
  }
  return undefined; // complete/aborted → clear
}

function countDone(g: Goal): number {
  let n = 0;
  const walk = (ts: Array<{ status: string; subtasks?: any[] }>) => {
    for (const t of ts) {
      if (t.status === "complete") n++;
      if (t.subtasks) walk(t.subtasks);
    }
  };
  walk(g.taskList?.tasks ?? []);
  return n;
}

function countTotal(g: Goal): number {
  let n = 0;
  const walk = (ts: Array<{ subtasks?: any[] }>) => {
    for (const t of ts) {
      n++;
      if (t.subtasks) walk(t.subtasks);
    }
  };
  walk(g.taskList?.tasks ?? []);
  return n;
}

// ---- above-editor widget (multi-line panel) ----

/**
 * Widget lines for ctx.ui.setWidget("pi-glla", lines).
 * Returns undefined when nothing is worth showing.
 */
export function buildWidgetLines(state: State, audit?: AuditDisplayProgress | null, now = Date.now()): string[] | undefined {
  if (state.loop?.active) return loopLines(state.loop, now);
  const g = state.goal;
  if (!g) return undefined;
  if (g.status === "complete" || g.status === "aborted") return undefined;
  return goalLines(g, state, audit, now);
}

function goalLines(g: Goal, state: State, audit: AuditDisplayProgress | null | undefined, now: number): string[] {
  const icon = g.status === "paused" ? "⏸" : g.status === "auditing" ? "⟡" : "◆";
  const head = `${icon} ${truncate(g.objective.replace(/\s+/g, " "), 64)}`;
  const lines = [head, `├─ ${statusLabel(g.status)} · ${fmtElapsed(now - Date.parse(g.createdAt))} · ${fmtTokens(g.usage?.tokensUsed ?? 0)}/${fmtTokens(g.usage?.tokensLimit ?? 10_000_000)} tok`];
  if (g.status === "auditing") {
    lines.push(`├─ auditor: ${audit?.label ?? "running"}${audit?.currentTool ? ` · ${truncate(audit.currentTool, 30)}` : ""}`);
    if (audit?.elapsedMs) lines.push(`└─ ${fmtElapsed(audit.elapsedMs)} in isolated session`);
    else lines.push(`└─ isolated session, read-only tools`);
    return lines;
  }
  if (g.status === "paused" && g.pauseReason) {
    lines.push(`├─ ${truncate(g.pauseReason, 60)}`);
    if (g.pauseSuggestedAction) lines.push(`└─ ${truncate(g.pauseSuggestedAction, 60)}`);
    return lines;
  }
  const next = nextPending(g);
  if (next) lines.push(`├─ next: ${truncate(next, 56)}`);
  const queue = state.list?.length ?? 0;
  lines.push(`└─ ${queue > 0 ? `list ${queue} · ` : ""}/goal status · /glla`);
  return lines;
}

function loopLines(l: LoopState, now: number): string[] {
  const arrow = l.direction === "min" ? "↓" : "↑";
  const lines = [
    `◆ ${truncate(l.target, 64)}`,
    `├─ loop ${arrow} iter ${l.iteration}/${l.maxIterations} · ${fmtElapsed(now - Date.parse(l.startedAt))}`,
    `├─ best ${l.bestValue ?? "n/a"} · last ${l.lastValue ?? "n/a"} · stall ${l.stallCount}/${l.plateauWindow}`,
    `└─ ${truncate(l.measureCmd, 56)}`,
  ];
  if (l.branchName) lines.push(`   ⎇ ${truncate(l.branchName, 50)}`);
  return lines;
}

function statusLabel(s: string): string {
  return s === "active" ? "active" : s;
}

function nextPending(g: Goal): string | undefined {
  const tasks = g.taskList?.tasks ?? [];
  const queue = [...tasks];
  while (queue.length > 0) {
    const t = queue.shift()!;
    if (t.status === "pending") return t.title;
    if (t.subtasks) queue.push(...t.subtasks);
  }
  return undefined;
}
