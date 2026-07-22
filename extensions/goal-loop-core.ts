/**
 * pi-goal-list-loop-audit — v0.1.0
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
 *
 * v0.12.0: counts input+output (real spend) when the usage object carries
 * the split; totalTokens includes cache reads, which inflate 10-50× on long
 * sessions (a day-long goal "used" 216M while real spend was a fraction).
 */
export function sumNewAssistantTokens(messages: unknown[], seen: Set<string>): number {
  let total = 0;
  for (const m of messages) {
    const msg = m as {
      role?: string;
      timestamp?: unknown;
      usage?: { input?: unknown; output?: unknown; totalTokens?: unknown };
    };
    if (msg?.role !== "assistant") continue;
    const u = msg.usage;
    const split = (typeof u?.input === "number" ? u.input : 0) + (typeof u?.output === "number" ? u.output : 0);
    const tokens = split > 0 ? split : (typeof u?.totalTokens === "number" ? u.totalTokens : 0);
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
 * Parse a bulk list-import file (v0.8.1): markdown checklists (`- [ ]`,
 * `- [x]`), bullets (`-`, `*`, `•`), numbered items (`1.`, `2)`), and plain
 * lines all become queue items. Headings (`# …`), blank lines, and HTML
 * comments are skipped. A sisyphus-style plan file should import clean.
 */
export function parseListImport(content: string): string[] {
  const items: string[] = [];
  for (const line of content.split("\n")) {
    let t = line.trim();
    if (!t) continue;
    if (t.startsWith("#")) continue;                    // headings
    if (t.startsWith("<!--")) continue;                 // html comments
    if (/^[-=_*]{3,}$/.test(t)) continue;               // hr rules
    t = t.replace(/^-\s*\[[ xX]\]\s*/, "");              // - [ ] / - [x]
    t = t.replace(/^[-*•]\s+/, "");                      // bullets
    t = t.replace(/^\d+[.)]\s+/, "");                    // 1. / 2)
    t = t.trim();
    if (t) items.push(t);
  }
  return items;
}

/**
 * Detect whether a `/list add` argument is a readable file (v0.8.2). File
 * detection, not a separate verb: `/list add plan.md` bulk-imports when the
 * path exists, and is an objective when it doesn't. Returns the absolute
 * path or null. Directories return null.
 */
export function resolveImportFile(cwd: string, arg: string): string | null {
  const trimmed = arg.trim();
  if (!trimmed || trimmed.includes("\n")) return null;
  // Cheap short-circuit: objectives rarely look like paths; require a path
  // separator or a file-extension-ish suffix before hitting the filesystem.
  if (!/[\\/]/.test(trimmed) && !/\.[A-Za-z0-9]{1,8}$/.test(trimmed)) return null;
  try {
    const abs = path.resolve(cwd, trimmed);
    const stat = fs.statSync(abs);
    return stat.isFile() ? abs : null;
  } catch {
    return null;
  }
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

/**
 * Should /goal args go through contract drafting instead of direct activation?
 * Rule (v0.11.0): any objective WITHOUT an explicit "Done when:" clause is
 * vague enough to grill first — the pi-goal-x lesson (arg + Enter is worse
 * than a 5-minute draft). An explicit contract clause activates instantly.
 */
export function goalArgsNeedDrafting(args: string): boolean {
  const t = args.trim();
  if (!t) return false; // no-args is already the drafting path
  return !/\bdone\s+when\s*:/i.test(t);
}

/**
 * Build the seeded drafting message (v0.14.0). v0.13.0 had the PLUGIN ask
 * three canned questions — a questionnaire, not a grilling: it accepted
 * non-answers ("not sure", "none") and produced weak contracts. The LLM
 * does the interviewing (its strength); the plugin only enforces the floor
 * via draftProposalBlock: propose is blocked until the user has replied.
 */
export function buildSeedGrillMessage(tmpl: string, seed: string, tool: string): string {
  return `${tmpl}\n\nThe user's initial objective (verbatim): ${seed}\n\nGRILL THEM ABOUT THIS SEED BEFORE PROPOSING. ${tool} is BLOCKED until the user has replied to at least one of your questions — proposing without interviewing returns an error.\n\nHow to grill:\n- Ask ONE sharp, seed-specific question at a time — about THIS objective, not generic filler. If an ask_user_question tool is available in this session, prefer it (structured options render better); plain conversation is fine for free-form answers.\n- Every question ships with a recommended default the user can accept with "yes".\n- Probe what matters: what "done" concretely looks like (checkable evidence — files, commands, behaviors), scope boundaries (what is explicitly OUT), constraints (what must not change), and priorities when the seed bundles several wishes.\n- A non-answer ("not sure", "none", "whatever") is a trigger to offer 2-3 concrete options to pick from — never silently proceed on a non-answer.\n- Do targeted read-only research first when it makes your questions sharper (repo layout, existing docs).\n- Do NOT activate the raw seed. Do NOT implement anything. When the contract is concrete, call ${tool}.`;
}

/**
 * The drafting floor (v0.14.0): the propose tools call this before opening
 * the user's Confirm dialog. 0 user replies since drafting started → the
 * agent is attempting a contract dump; block it with instructions. The
 * mechanism guarantees an interview HAPPENED; question quality is the
 * model's job (shaped by buildSeedGrillMessage).
 */
export function draftProposalBlock(userReplies: number, blockedAttempts = 0): string | null {
  if (userReplies > 0) return null;
  const base = "INTERVIEW FIRST — you have not received a single user reply since drafting started. Ask the user ONE sharp question about their objective (seed-specific, with a recommended default; challenge non-answers by offering concrete options), wait for the answer, and only then call the propose tool again. The Confirm dialog stays closed until the user has actually been heard.";
  // v0.15.1 escape hatch: typed chat replies AND answered ask_user_question
  // dialogs both count. If we have blocked 3+ proposals, the replies are
  // arriving through a path this plugin cannot see — hand the user a manual
  // unlock instead of manufacturing yet another interview round.
  if (blockedAttempts >= 3) {
    return base + " NOTE: proposals have been blocked repeatedly despite interviewing — the reply counter may not see your channel. Tell the user plainly: 'type any chat message (e.g. \"go on\") to unlock the Confirm dialog', wait for it, then propose again. Do NOT ask another interview question first.";
  }
  return base;
}

/**
 * v0.15.1: an ask_user_question tool result counts as a user reply during
 * drafting — dialog answers arrive as tool results, not chat messages.
 * Answered = not cancelled (Esc) with at least one answer recorded.
 */
export function askUserQuestionAnswered(toolName: string, details: unknown): boolean {
  if (toolName !== "ask_user_question") return false;
  if (!details || typeof details !== "object") return false;
  const d = details as { answers?: unknown; cancelled?: unknown };
  return d.cancelled === false && Array.isArray(d.answers) && d.answers.length > 0;
}

/**
 * Take item at 1-based index n out of the list (v0.10.0 pick-any-item
 * activation). n=1 is the head (FIFO default). Returns [taken, rest] or
 * null when n is out of range.
 */
export function takeAt<T>(items: T[], n: number): [T, T[]] | null {
  if (!Number.isInteger(n) || n < 1 || n > items.length) return null;
  const taken = items[n - 1]!;
  return [taken, items.filter((_, i) => i !== n - 1)];
}

export interface State {
  goal: Goal | null;
  /** Loop 2: queue of pending goal items. Activated one at a time. */
  list?: ListItem[];
  /** Loop 3: metric-driven forever loop. */
  loop?: import("./goal-loop-forever.js").LoopState;
}

/** Default per-goal token budget (v0.9.7): a runaway threshold, not a
 * "big goal" threshold — real research/feature goals legitimately burn 2-4M.
 * Loop 3 doesn't rely on this cap (it has max-iterations + plateau brakes). */
export const DEFAULT_TOKEN_LIMIT = 0; // 0 = opt-in guard, off by default (v0.12.0)

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
