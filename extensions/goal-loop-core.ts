/**
 * pi-goal-list-loop-audit — v0.24.5
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
  /** v0.24.2: the auditor's third verdict — the goal can NEVER be satisfied as stated. */
  impossible?: boolean;
  impossibleReason?: string;
  model: string;
  thinkingLevel?: string;
  report?: string;
  /** Infrastructure failure detail (abort, auth, no model). Verdicts only — an entry with error and no report is not a real audit. */
  error?: string;
  /** regression_shield outcome when the goal had a verification contract. */
  regressionShieldPassed?: boolean;
  /** Contract items the shield found unreferenced (fed into the next audit's prompt, v0.22.6). */
  regressionShieldMissing?: string[];
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
  | { kind: "sub"; name: "status" | "pause" | "resume" | "cancel" | "tweak" | "archive" | "start"; rest: string };

const GOAL_EXACT_SUBS = new Set(["status", "pause", "resume", "cancel"]);
const GOAL_ARG_SUBS = new Set(["tweak", "archive", "start"]);

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
    return { kind: "sub", name: first as "tweak" | "archive" | "start", rest };
  }
  return { kind: "set", text: trimmed };
}

/**
 * Parse a bulk list-import file (v0.8.1): markdown checklists (`- [ ]`,
 * `- [x]`), bullets (`-`, `*`, `•`), numbered items (`1.`, `2)`), and plain
 * lines all become list items. Headings (`# …`), blank lines, and HTML
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
 * During a LIST drafting session the agent must not add items one by one
 * with list_add/list_activate — that bypasses the user's Confirm gate
 * (observed in the wild: the agent decomposed a dump and ACTIVATED the first
 * item with zero confirmation). The batch path is propose_goal_draft's
 * items[]: one Confirm for the whole list. User commands (/list add) are
 * unaffected — only the agent tools are gated.
 */
export function listMutationBlocked(draftingTarget: string | null): boolean {
  return draftingTarget === "list";
}

export const LIST_DRAFTING_BLOCK_MESSAGE =
  "LIST DRAFTING IN PROGRESS — do not add items one by one. Decompose the request into an items[] array and call propose_goal_draft ONCE: the user confirms the whole batch in a single dialog. list_add / list_activate work again after the drafting session ends.";

/**
 * Route natural-language text handed to `/list` with no subcommand verb
 * (v0.18.0). The user typed a dump — "fix x, do y, write docs" — not a
 * command. Flexible by detection, never a usage error:
 *   file path        → bulk import (sisyphus/Ralph plan file)
 *   multi-line paste → batch add (structure is already explicit)
 *   has "Done when:" → one direct item (explicit contract)
 *   anything else    → conversational decomposition (drafting session;
 *                      the agent shapes it into items[], one Confirm)
 * The explicit verb `/list add` stays the direct escape hatch (symmetric
 * with `/goal start`): it skips the draft branch.
 */
export type ListTextRoute =
  | { kind: "file"; path: string }
  | { kind: "batch"; items: string[] }
  | { kind: "direct"; text: string }
  | { kind: "draft"; seed: string };

export function routeListText(cwd: string, raw: string): ListTextRoute {
  const importFile = resolveImportFile(cwd, raw);
  if (importFile) return { kind: "file", path: importFile };
  if (raw.includes("\n")) {
    const pasted = parseListImport(raw);
    if (pasted.length > 1) return { kind: "batch", items: pasted };
  }
  if (!goalArgsNeedDrafting(raw)) return { kind: "direct", text: raw };
  return { kind: "draft", seed: raw };
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

/** Backward-compatible default for executor-visible auditor feedback. */
export const DEFAULT_AUDIT_FEEDBACK_CHARS = 800;

/**
 * Bound the auditor report returned to the executor after disapproval.
 * A limit of 0 explicitly means "show the full report".
 */
export function auditFeedbackExcerpt(output: string, maxChars: number): string {
  return maxChars === 0 ? output : output.slice(0, maxChars);
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
  // v0.23.7: any "done when" phrase counts — requiring the colon to
  // immediately follow made "Done when ALL of the following are true:"
  // route to the interview even though the user wrote a contract.
  return !/\bdone\s+when\b/i.test(t);
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
  /** Loop 2: list of pending goal items. Activated one at a time. */
  list?: ListItem[];
  /** Loop 3: metric-driven forever loop. */
  loop?: import("./goal-loop-forever.js").LoopState;
}

/** v0.24.2: count TRAILING consecutive disapprovals (the disapproval-cap
 *  input). Shield-blocks (approved:true) and infra errors (neither flag)
 *  break the streak — they are not verdicts on the work. */
export function countTrailingDisapprovals(history: AuditVerdict[]): number {
  let n = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]!.disapproved) n++;
    else break;
  }
  return n;
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
  const dir = path.join(cwd, ".pi-glla");
  // v0.17.0: one-time migration of the pre-rename state dir (.pi-gla →
  // .pi-glla). Active goals, ledgers, and project settings move with the
  // name — no relics, no lost state.
  const legacy = path.join(cwd, ".pi-gla");
  try {
    if (!fs.existsSync(dir) && fs.existsSync(legacy)) fs.renameSync(legacy, dir);
  } catch {
    // read-only fs or partial state — fall through and use the new dir
  }
  return dir;
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
      lines.push(`- ${v.at} — ${v.approved ? "approved" : v.impossible ? "impossible" : "disapproved"} — \`${v.model}\``);
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

/**
 * Session-restore gate (v0.21.0): a session that carries conversation
 * history ("resume" | "reload" | "fork") IS the goal's own context —
 * auto-resuming work there is natural. A fresh session ("startup" | "new",
 * or an older pi that reports no reason) has no context — restored state
 * HOLDS until an explicit /goal resume (or /glla autoresume=on, the rig
 * setting for unattended restarts). One mechanical predicate; no heuristics.
 */
export function shouldAutoResumeOnSessionStart(reason: string | undefined, autoResume: boolean | undefined): boolean {
  if (autoResume === true) return true;
  return reason === "resume" || reason === "reload" || reason === "fork";
}

/**
 * v0.23.5: normalize a drafter-supplied verification contract for the
 * Confirm dialog AND for storage. Three cleanups, all mechanical:
 *  1. Drop bare introducer lines ("Done when:", "Done when ALL of the
 *     following are true:") — the dialog adds its own "Done when" header;
 *     a model-supplied one renders doubled (field-observed) and pollutes
 *     the shield's item list.
 *  2. Strip a glued "Done when: " prefix on a content line.
 *  3. Renumber bullet/numbered lines sequentially ("1.", "2.", ...) so the
 *     dialog reads as a checklist and reject-feedback can cite item
 *     numbers. Non-bullet prose lines pass through untouched.
 */
export function normalizeDraftContract(raw: string): string {
  const lines = raw
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => !/^(?:done when|verified when|verify|verification)\b[^:]*:\s*$/i.test(l))
    .map((l) => l.replace(/^(?:done when|verified when)\s*:\s+/i, ""))
    .filter((l) => l.length > 0);
  let n = 0;
  return lines
    .map((l) => {
      const m = l.match(/^(?:[-*•]\s+|\d+[.)]\s+)(.+)$/);
      return m ? `${++n}. ${m[1]}` : l;
    })
    .join("\n");
}

/** Count the numbered checklist items in a normalized contract. */
export function draftContractItemCount(normalized: string): number {
  return normalized.split("\n").filter((l) => /^\d+\.\s/.test(l)).length;
}

/**
 * Split raw objective text into { objective, verificationContract } at the
 * first "Done when…:"-family marker (line-start preferred, inline fallback
 * for one-liners). v0.23.7: the marker family accepts ANY text between the
 * keyword and the colon ("Done when ALL of the following are true:") —
 * the shield's contractItems already drops such introducer lines
 * (v0.23.4), and goalArgsNeedDrafting recognizes the same phrase, so the
 * three "done when" parsers can no longer drift apart. Lives in the pure
 * module so tests exercise THIS function, not a copy (the pre-0.23.7 test
 * re-implemented it and silently went stale).
 */
export function extractVerificationContract(raw: string): { objective: string; verificationContract: string } {
  // Line-based first: a marker at line start begins the contract block.
  const lines = raw.split("\n");
  let mode: "obj" | "verify" = "obj";
  const objParts: string[] = [];
  const verifyParts: string[] = [];
  for (const line of lines) {
    if (line.match(/^\s*(?:done when|verified when|verify|verification|done)\b[^:]*:/i)) {
      mode = "verify";
    }
    if (mode === "obj") objParts.push(line);
    else verifyParts.push(line);
  }
  let objective = objParts.join("\n").trim();
  let verificationContract = verifyParts.join("\n").trim();

  // Inline fallback: users write one-liners like
  //   "Create x.txt. Done when: grep -q ok x.txt"
  // where the marker is mid-line. Split at the first inline marker.
  if (!verificationContract) {
    const m = raw.match(/^(.*?)(?:\.|;)??\s+(?:done when|verified when|verify|verification)\b[^:]*:\s*(.+)$/is);
    if (m) {
      objective = (m[1] ?? "").trim().replace(/[.;]\s*$/, "");
      verificationContract = (m[2] ?? "").trim();
    }
  }
  return { objective, verificationContract };
}

/**
 * v0.23.8: subagent-session ownership. pi-subagents binds extensions in
 * subagent sessions too, so glla's session_start/handlers fire there with
 * the same module state. The MAIN session owns the goal/loop; subagent
 * sessions are workers — they must never clobber the loop's ctx handle
 * (a headless subagent ctx would silently kill the heartbeat/wedge
 * machinery), never receive continuation injection, and never mutate goal
 * state. pi hands a FRESH ctx wrapper per event (verified in
 * dist/core/extensions/runner.js — createContext() per emit), so object
 * identity is useless; ctx.sessionManager is the stable per-session
 * discriminator (each subagent gets its own SessionManager).
 */
export type OwnerClaim = "claim" | "refresh" | "foreign";
export function classifySessionCtx(ownerSession: unknown, ownerLive: boolean, sessionManager: unknown): OwnerClaim {
  if (!ownerSession || !ownerLive) return "claim";
  return sessionManager === ownerSession ? "refresh" : "foreign";
}

// =================================================================
// v0.24.5: tool-visibility self-heal
// =================================================================
//
// Root cause (INCIDENT-COMPLETION-BLACKHOLE-2026-07-23): external
// extensions like pi-plugin-list-selector-modlist call pi.setActiveTools
// with a frozen tool snapshot at session_start. When glla's session_start
// handler runs BEFORE theirs (load order), our lazily-registered agent
// tools get registered, briefly auto-activated, then wiped from the
// model-facing active set on the very next pi.setActiveTools call from
// modlist. Commands, widget, watchdog keep working (they don't go
// through the tool registry), but every agent tool — complete_goal,
// propose_loop_draft, etc. — answers "Tool not found" to the model.
//
// Self-heal: any handler that triggers registerAgentTools must also
// ensure the registered tool names are present in pi.getActiveTools(),
// re-adding any missing ones via pi.setActiveTools. Once per session,
// notify the user naming the external allowlist as the likely culprit
// so they can fix their profile once and silence it.

export const GLLA_TOOL_NAMES = [
  "complete_goal",
  "pause_goal",
  "complete_task",
  "update_task_status",
  "propose_goal_draft",
  "propose_loop_draft",
  "propose_loop_refine",
  "list_add",
  "list_activate",
  "list_status",
  "propose_task_list",
] as const;

export type GllaToolName = (typeof GLLA_TOOL_NAMES)[number];

export function missingGllaTools(activeNames: readonly string[]): readonly GllaToolName[] {
  const active = new Set(activeNames);
  return GLLA_TOOL_NAMES.filter((n) => !active.has(n));
}
