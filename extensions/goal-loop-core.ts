/**
 * pi-goal-loop-audit — v0.1.0
 * extensions/goal-loop-core.ts
 *
 * Shared types, state machine, JSONL persistence, helpers.
 *
 * Design: see docs/DESIGN.md
 */

import * as fs from "node:fs";
import * as path from "node:path";

// =================================================================
// Types
// =================================================================

export type Status =
  | "active"
  | "auditing"
  | "complete"
  | "paused"
  | "aborted";

export type Policy = "goal"; // v0.1.0 only. v0.2.0: "list". v0.3.0: "loop".

export interface Task {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "complete";
  subtasks?: Task[];
}

export interface TaskList {
  version: 1;
  tasks: Task[];
}

export interface AuditVerdict {
  at: string;
  approved: boolean;
  disapproved: boolean;
  model: string;
  thinkingLevel?: string;
  report?: string;
  /** Infrastructure failure detail (abort, auth, no model). Verdicts only — an entry with error and no report is not a real audit. */
  error?: string;
}

export interface Goal {
  id: string;
  objective: string;
  status: Status;
  policy: Policy;
  verificationContract?: string;
  autoContinue: boolean;
  taskList?: TaskList;
  auditHistory?: AuditVerdict[];
  stopReason?: string;
  pauseReason?: string;
  pauseSuggestedAction?: string;
  activePath?: string;
  archivedPath?: string;
  usage: {
    tokensUsed: number;
    tokensLimit: number;
  };
  createdAt: string;
  updatedAt: string;
}

export interface State {
  goal: Goal | null;
}

export const DEFAULT_STATE: State = {
  goal: null,
};

// =================================================================
// Path helpers
// =================================================================

export function piGlaDir(cwd: string): string {
  return path.join(cwd, ".pi-gla");
}

export function goalMdPath(cwd: string, id: string): string {
  return path.join(piGlaDir(cwd), "goals", `${id}.md`);
}

export function archiveDir(cwd: string): string {
  return path.join(piGlaDir(cwd), "archive");
}

export function archivedGoalPath(cwd: string, id: string): string {
  return path.join(archiveDir(cwd), `${id}.md`);
}

export function ledgerPath(cwd: string): string {
  return path.join(piGlaDir(cwd), "active.jsonl");
}

// =================================================================
// Persistence
// =================================================================

export function ensureDirs(cwd: string): void {
  fs.mkdirSync(path.join(piGlaDir(cwd), "goals"), { recursive: true });
  fs.mkdirSync(archiveDir(cwd), { recursive: true });
}

export function readState(cwd: string): State {
  const file = ledgerPath(cwd);
  if (!fs.existsSync(file)) return { ...DEFAULT_STATE };
  const lines = fs.readFileSync(file, "utf-8").split("\n").filter(Boolean);
  if (lines.length === 0) return { ...DEFAULT_STATE };
  let parsed: Partial<State> = {};
  for (const line of lines) {
    try {
      const evt = JSON.parse(line);
      if (evt.type === "state") parsed = { ...parsed, ...evt.value };
    } catch {
      // skip malformed lines
    }
  }
  return parsed.goal ? ({ goal: parsed.goal } as State) : { ...DEFAULT_STATE };
}

export function appendLedger(cwd: string, type: string, value: unknown): void {
  ensureDirs(cwd);
  const line = JSON.stringify({ type, value, at: new Date().toISOString() });
  fs.appendFileSync(ledgerPath(cwd), line + "\n");
}

export function writeGoalMd(cwd: string, goal: Goal): string {
  ensureDirs(cwd);
  const file = goalMdPath(cwd, goal.id);
  const md = renderGoalMarkdown(goal);
  fs.writeFileSync(file, md);
  return file;
}

export function readGoalMd(cwd: string, id: string): string | null {
  const file = goalMdPath(cwd, id);
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, "utf-8");
}

// =================================================================
// Renderer — replace pi-goal-x's hand-concat detailedSummary
// =================================================================

export function renderGoalMarkdown(goal: Goal): string {
  const lines: string[] = [];
  lines.push(`# Goal`);
  lines.push("");
  lines.push(`**Status**: ${statusLabel(goal.status)}`);
  lines.push(`**Policy**: ${goal.policy}`);
  lines.push(`**Auto-continue**: ${goal.autoContinue ? "on" : "off"}`);
  if (goal.activePath) lines.push(`**File**: \`${path.relative(path.dirname(goal.activePath), goal.activePath) || goal.activePath}\``);
  if (goal.archivedPath) lines.push(`**Archive**: \`${path.relative(path.dirname(goal.archivedPath), goal.archivedPath) || goal.archivedPath}\``);
  if (goal.stopReason) lines.push(`**Stop reason**: ${goal.stopReason}`);
  if (goal.pauseReason) lines.push(`**Pause reason**: ${goal.pauseReason}`);
  if (goal.pauseSuggestedAction) lines.push(`**Agent suggests**: ${goal.pauseSuggestedAction}`);
  lines.push("");
  lines.push("## Objective");
  lines.push("");
  lines.push("> " + goal.objective);
  lines.push("");
  if (goal.verificationContract) {
    lines.push("## Verification contract");
    lines.push("");
    lines.push(goal.verificationContract);
    lines.push("");
  }
  if (goal.taskList && goal.taskList.tasks.length > 0) {
    lines.push("## Tasks");
    lines.push("");
    renderTaskTreeMarkdown(goal.taskList.tasks, lines, 0);
    lines.push("");
  }
  if (goal.auditHistory && goal.auditHistory.length > 0) {
    lines.push("## Audit history");
    lines.push("");
    for (const v of goal.auditHistory) {
      lines.push(`- ${v.at} — ${v.approved ? "approved" : "disapproved"} — \`${v.model}\``);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function renderTaskTreeMarkdown(tasks: Task[], out: string[], depth: number): void {
  for (const t of tasks) {
    const indent = "  ".repeat(depth);
    const bullet = t.status === "complete" ? "- [x]" : t.status === "in_progress" ? "- [~]" : "- [ ]";
    out.push(`${indent}${bullet} ${t.title} \`${t.id}\``);
    if (t.subtasks && t.subtasks.length > 0) {
      renderTaskTreeMarkdown(t.subtasks, out, depth + 1);
    }
  }
}

// =================================================================
// Status helpers
// =================================================================

export function statusLabel(status: Status | null | undefined): string {
  switch (status) {
    case "active": return "active";
    case "auditing": return "auditing";
    case "complete": return "complete";
    case "paused": return "paused";
    case "aborted": return "aborted";
    default: return "no goal";
  }
}

// =================================================================
// ID generation
// =================================================================

export function nowIso(): string {
  return new Date().toISOString();
}

export function newGoalId(): string {
  const ts = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${ts}-${rand}`;
}

// =================================================================
// Task helpers
// =================================================================

export function findNextPendingTask(tasks: Task[]): { id: string; title: string } | undefined {
  const queue = [...tasks];
  while (queue.length > 0) {
    const t = queue.shift()!;
    if (t.status === "pending") return { id: t.id, title: t.title };
    // Push subtasks regardless of parent status; we want BFS to find
    // the first pending task anywhere in the tree. A parent's status
    // does not preclude one of its subtasks being pending.
    if (t.subtasks && t.subtasks.length > 0) queue.push(...t.subtasks);
  }
  return undefined;
}

export function buildTaskSummary(tasks: Task[]): string {
  let total = 0;
  let complete = 0;
  const queue = [...tasks];
  while (queue.length > 0) {
    const t = queue.shift()!;
    total++;
    if (t.status === "complete") complete++;
    if (t.subtasks) queue.push(...t.subtasks);
  }
  return `${complete}/${total} done`;
}

// =================================================================
// Lightweight structural clone (we don't need deepcopy for our shape)
// =================================================================

export function cloneGoal(goal: Goal): Goal {
  return JSON.parse(JSON.stringify(goal));
}
