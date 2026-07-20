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

export type Policy = "goal" | "list"; // v0.3.0: "loop".

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

// =================================================================
// Task-list proposal validation (used by the propose_task_list tool)
//
// The caps are the fix for pi-goal-x flaw #4: the agent could grow subtasks
// indefinitely, drifting into self-generated busywork. Hard limits keep a
// breakdown a breakdown.
// =================================================================

export const MAX_TOP_LEVEL_TASKS = 20;
export const MAX_SUBTASKS_PER_TASK = 5;

export interface TaskProposal {
  title: string;
  subtasks?: string[];
}

/** Validate a proposed breakdown. Returns an error string or null. */
export function validateTaskProposal(tasks: TaskProposal[]): string | null {
  if (!Array.isArray(tasks) || tasks.length === 0) return "Empty task list.";
  if (tasks.length > MAX_TOP_LEVEL_TASKS) {
    return `Too many top-level tasks (${tasks.length}); max ${MAX_TOP_LEVEL_TASKS}. Coarser granularity, please.`;
  }
  for (const t of tasks) {
    if (!t.title || !t.title.trim()) return "Every task needs a non-empty title.";
    const n = t.subtasks?.length ?? 0;
    if (n > MAX_SUBTASKS_PER_TASK) {
      return `Task "${t.title}" has ${n} subtasks; max ${MAX_SUBTASKS_PER_TASK}. Merge or split into coarser tasks.`;
    }
  }
  return null;
}

/** Assign hierarchical ids ("1", "1.1", …) and pending statuses to a proposal. */
export function buildTaskList(tasks: TaskProposal[]): TaskList {
  return {
    version: 1,
    tasks: tasks.map((t, i) => ({
      id: String(i + 1),
      title: t.title.trim(),
      status: "pending" as const,
      subtasks: (t.subtasks ?? []).map((s, j) => ({
        id: `${i + 1}.${j + 1}`,
        title: s.trim(),
        status: "pending" as const,
      })),
    })),
  };
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
  /** regression_shield outcome when the goal had a verification contract. */
  regressionShieldPassed?: boolean;
}

/**
 * Sum token usage across assistant messages, counting each message once.
 * `agent_end` events may include already-seen history, so callers pass a
 * dedup set keyed by timestamp+tokens (good-enough identity for counting).
 */
export function sumNewAssistantTokens(messages: unknown[], seen: Set<string>): number {
  let total = 0;
  for (const m of messages) {
    const msg = m as { role?: string; timestamp?: unknown; usage?: { totalTokens?: unknown } };
    if (msg?.role !== "assistant") continue;
    const tokens = typeof msg.usage?.totalTokens === "number" ? msg.usage.totalTokens : 0;
    if (tokens <= 0) continue;
    const key = `${String(msg.timestamp ?? "?")}:${tokens}`;
    if (seen.has(key)) continue;
    seen.add(key);
    total += tokens;
  }
  return total;
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

/**
 * Route `/goal` args (v0.8.0 top-level consolidation). Subcommands match ONLY
 * on exact word (except tweak/archive which take args) — an objective that
 * starts with "pause" ("/goal pause the pipeline and fix it") must set a
 * goal, not pause one.
 */
export type GoalRoute =
  | { kind: "draft" }
  | { kind: "set"; text: string }
  | { kind: "sub"; name: "status" | "pause" | "resume" | "cancel" | "tweak" | "archive"; rest: string };

const GOAL_EXACT_SUBS = new Set(["status", "pause", "resume", "cancel"]);
const GOAL_ARG_SUBS = new Set(["tweak", "archive"]);

export function routeGoalArgs(raw: string): GoalRoute {
  const trimmed = raw.trim();
  if (!trimmed) return { kind: "draft" };
  const space = trimmed.indexOf(" ");
  const first = (space === -1 ? trimmed : trimmed.slice(0, space)).toLowerCase();
  const rest = space === -1 ? "" : trimmed.slice(space + 1).trim();
  if (GOAL_EXACT_SUBS.has(first) && rest === "") {
    return { kind: "sub", name: first as "status" | "pause" | "resume" | "cancel", rest: "" };
  }
  if (GOAL_ARG_SUBS.has(first)) {
    return { kind: "sub", name: first as "tweak" | "archive", rest };
  }
  return { kind: "set", text: trimmed };
}

/**
 * Layered settings merge (v0.7.0): later layers win, but only for keys they
 * actually define — an `undefined` value in a layer means "not set here",
 * never "set to undefined". Used for defaults → global → project resolution.
 */
export function mergeSettings<T extends Record<string, unknown>>(base: T, ...layers: Array<Partial<T> | null | undefined>): T {
  const out: Record<string, unknown> = { ...base };
  for (const layer of layers) {
    if (!layer) continue;
    for (const [k, v] of Object.entries(layer)) {
      if (v !== undefined) out[k] = v;
    }
  }
  return out as T;
}

export interface ListItem {
  id: string;
  objective: string;
  verificationContract?: string;
  addedAt: string;
}

export interface State {
  goal: Goal | null;
  /** Loop 2: queue of pending goal items. Activated one at a time. */
  list?: ListItem[];
  /** Loop 3: metric-driven forever loop. */
  loop?: import("./goal-loop-forever.js").LoopState;
}

export const DEFAULT_STATE: State = {
  goal: null,
  list: [],
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
  return {
    goal: parsed.goal ?? null,
    list: Array.isArray(parsed.list) ? parsed.list : [],
    loop: parsed.loop && typeof parsed.loop === "object" ? parsed.loop as State["loop"] : undefined,
  };
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
