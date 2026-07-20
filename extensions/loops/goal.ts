/**
 * pi-goal-loop-audit — v0.1.0
 * extensions/loops/goal.ts
 *
 * The goal loop. The agent continues working, and on complete_goal,
 * an isolated auditor verifies the work.
 *
 * Design: see docs/DESIGN.md.
 *
 * Scope of v0.1.0:
 *   - /goal "<objective>"       Set + start now (no drafting)
 *   - /goal-status                   Show state
 *   - /goal-pause                    Pause
 *   - /goal-resume                   Resume
 *   - /goal-cancel                   Abort
 *   - /goal-settings                 Auditor model + thinking
 *
 * NOT in v0.1.0 (deferred to v0.2.0):
 *   - /list add|show|clear      Queue of goals (loop 2)
 *   - /goal-draft                    Drafting with structured Q&A
 *   - /goal-tweak                    Modify active goal in-place
 *   - regression_shield for the auditor (raw output per item)
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  type Goal,
  type State,
  type Status,
  appendLedger,
  archiveDir,
  archivedGoalPath,
  buildTaskList,
  buildTaskSummary,
  sumNewAssistantTokens,
  type TaskProposal,
  validateTaskProposal,
  cloneGoal,
  ensureDirs,
  findNextPendingTask,
  goalMdPath,
  newGoalId,
  nowIso,
  piGlaDir,
  readState,
  renderGoalMarkdown,
  statusLabel,
  writeGoalMd,
} from "../goal-loop-core.js";
import { runGoalCompletionAuditor } from "../goal-loop-auditor.js";
import {
  applyMeasurement,
  loopBranchName,
  parseLoopStartArgs,
  parseMetric,
  type LoopState,
} from "../goal-loop-forever.js";
import {
  accountTurnForNudges,
  BACKOFF_HARD_CAP_MS,
  BACKOFF_IDLE_RETRY_MS,
  backoffMs,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_MAX_NUDGES,
  HEARTBEAT_STALL_MS,
  humanMs,
  shouldHeartbeatRefire,
  shouldPauseAfterBackoff,
} from "../goal-loop-backoff.js";

// =================================================================
// Constants
// =================================================================

const GOAL_EVENT_ENTRY = "goal-event";
const STATE_ENTRY = "goal-state";

// =================================================================
// Module-level state (one per session)
// =================================================================

// The ExtensionAPI captured in the factory. sendMessage lives on the API,
// not on ExtensionContext, so continuation sends need it at module scope.
let extensionApi: ExtensionAPI | null = null;

// The most recent ExtensionContext seen from any event or command handler.
// pi replaces sessions (newSession/fork/reload) and stale ctx throws on use,
// so timers must never capture a ctx — they read lastCtx at fire time.
let lastCtx: ExtensionContext | null = null;

function rememberCtx(ctx: ExtensionContext): void {
  lastCtx = ctx;
}

let state: State = { goal: null };

// Drafting mode: a no-arg loop command starts a clarification turn; the agent
// must call propose_goal_draft / propose_loop_draft, which opens the user's
// Confirm dialog. The target decides where the confirmed contract lands.
let draftingTarget: "goal" | "list" | "loop" | null = null;

// Dedup set for token accounting (agent_end may replay seen messages).
const countedTokenMessages = new Set<string>();

// Heartbeat self-watchdog state: liveness is the loop's own job.
let lastActivityAt = Date.now();
let heartbeatNudges = 0;
let heartbeatTimer: NodeJS.Timeout | null = null;

function noteActivity(): void {
  lastActivityAt = Date.now();
}

function isSupervising(): boolean {
  return isLoopActive() || (!!state.goal && state.goal.status === "active" && state.goal.autoContinue);
}

function heartbeatTick(): void {
  const ctx = freshCtx();
  if (!ctx) return;
  let sessionIdle = false;
  try {
    sessionIdle = ctx.isIdle() && !ctx.hasPendingMessages();
  } catch {
    return;
  }
  const fire = shouldHeartbeatRefire({
    supervising: isSupervising(),
    sessionIdle,
    timerPending: continuationTimer !== null || loopTimer !== null,
    msSinceActivity: Date.now() - lastActivityAt,
    stallMs: HEARTBEAT_STALL_MS,
  });
  if (!fire) return;
  noteActivity();
  appendLedger(ctx.cwd, "heartbeat_refire", { nudgesSoFar: heartbeatNudges });
  ctx.ui.notify("Heartbeat: supervisor active but session stalled — re-firing continuation.", "info");
  if (isLoopActive()) {
    scheduleLoopTick(ctx);
  } else {
    scheduleContinuation(ctx, true);
  }
}

function startHeartbeat(): void {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(heartbeatTick, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref?.();
}
let continuationTimer: NodeJS.Timeout | null = null;
let continuationScheduledFor: string | null = null;
let iterationCounter = 0;
let toolCallsThisTurn = 0;
let consecutiveStuckIterations = 0;
let consecutiveErrorIterations = 0;
let consecutiveNoToolIterations = 0;

// =================================================================
// Helpers
// =================================================================

function clearContinuationTimer(): void {
  if (continuationTimer) {
    clearTimeout(continuationTimer);
    continuationTimer = null;
  }
  continuationScheduledFor = null;
}

function isActionableGoal(): boolean {
  return !!state.goal && state.goal.status === "active" && state.goal.autoContinue;
}

function freshCtx(): ExtensionContext | null {
  // A captured ctx throws "stale" after session replacement. Probe cheaply;
  // on stale, drop it and wait for the next event to hand us a fresh one.
  if (!lastCtx) return null;
  try {
    lastCtx.isIdle();
    return lastCtx;
  } catch {
    lastCtx = null;
    return null;
  }
}

function scheduleContinuation(ctx: ExtensionContext, force = false): void {
  if (!isActionableGoal()) return;
  rememberCtx(ctx);
  const goalId = state.goal!.id;
  if (!force && continuationScheduledFor === goalId) return;
  clearContinuationTimer();
  let delay = 0;
  try {
    delay = ctx.isIdle() && !ctx.hasPendingMessages() ? 0 : BACKOFF_IDLE_RETRY_MS;
  } catch {
    return;
  }
  continuationScheduledFor = goalId;
  continuationTimer = setTimeout(() => sendContinuation(goalId), delay);
  continuationTimer.unref?.();
}

function sendContinuation(goalId: string): void {
  continuationTimer = null;
  continuationScheduledFor = null;
  if (!isActionableGoal()) return;
  const ctx = freshCtx();
  if (!ctx) {
    // No live ctx — retry shortly; the next session event will refresh it.
    continuationScheduledFor = goalId;
    continuationTimer = setTimeout(() => sendContinuation(goalId), BACKOFF_IDLE_RETRY_MS);
    continuationTimer.unref?.();
    return;
  }
  if (!ctx.isIdle() || ctx.hasPendingMessages()) {
    continuationScheduledFor = goalId;
    continuationTimer = setTimeout(() => sendContinuation(goalId), BACKOFF_IDLE_RETRY_MS);
    continuationTimer.unref?.();
    return;
  }
  if (!extensionApi) return;
  try {
    extensionApi.sendMessage({
      customType: GOAL_EVENT_ENTRY,
      content: continuationPrompt(state.goal!),
      display: false,
    }, { triggerTurn: true, deliverAs: "followUp" });
  } catch {
    // API went stale mid-flight; next agent_end/session_start will reschedule.
  }
}

function continuationPrompt(goal: Goal): string {
  // Read the .md file as the template, then substitute {{tokens}}.
  // For v0.1.0 we inline-substitute so we don't need fs at runtime.
  const next = findNextPendingTask(goal.taskList?.tasks ?? []);
  const nextBlock = next
    ? `**Next pending task**: \`${next.id}\` — ${next.title}`
    : "**Next pending task**: (none — only call complete_goal when the objective is satisfied)";
  const taskSummary = goal.taskList?.tasks.length
    ? buildTaskSummary(goal.taskList.tasks)
    : "(no task list)";
  const tmplPath = path.resolve(__dirname, "..", "..", "prompts", "goal-loop-continuation.md");
  let tmpl: string;
  try {
    tmpl = fs.readFileSync(tmplPath, "utf-8");
  } catch {
    tmpl = "[template-not-found]";
  }
  return tmpl
    .replace(/\$\{GOAL_ID\}/g, goal.id)
    .replace(/\$\{OBJECTIVE\}/g, goal.objective)
    .replace(/\$\{VERIFICATION_CONTRACT\}/g, goal.verificationContract || "(none — auditor will decide based on objective)")
    .replace(/\$\{TASK_LIST\}/g, taskSummary)
    .replace(/\$\{NEXT_PENDING_TASK_BLOCK\}/g, nextBlock);
}

// =================================================================
// Goal lifecycle
// =================================================================

function createGoal(objective: string, ctx: ExtensionContext, policy: "goal" | "list" = "goal"): Goal {
  ensureDirs(ctx.cwd);
  // Extract verification contract if present in objective.
  const { objective: cleanObj, verificationContract } = extractVerificationContract(objective);
  const id = newGoalId();
  const goal: Goal = {
    id,
    objective: cleanObj,
    status: "active",
    policy,
    autoContinue: true,
    verificationContract: verificationContract || "",
    usage: { tokensUsed: 0, tokensLimit: loadSettings(ctx.cwd).tokenLimit ?? 1_000_000 },
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  return goal;
}

function extractVerificationContract(raw: string): { objective: string; verificationContract: string } {
  // Line-based first: a marker at line start begins the contract block.
  const lines = raw.split("\n");
  let mode: "obj" | "verify" = "obj";
  const objParts: string[] = [];
  const verifyParts: string[] = [];
  for (const line of lines) {
    const lower = line.toLowerCase();
    if (lower.match(/^\s*(?:done when|verify|verified when|verification|done):/)) {
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
    const m = raw.match(/^(.*?)(?:\.|;)??\s+(done when|verified when|verify|verification)\s*:\s*(.+)$/is);
    if (m) {
      objective = (m[1] ?? "").trim().replace(/[.;]\s*$/, "");
      verificationContract = (m[3] ?? "").trim();
    }
  }
  return { objective, verificationContract };
}

function persistState(ctx: ExtensionContext): void {
  appendLedger(ctx.cwd, "state", { goal: state.goal, list: state.list ?? [], loop: state.loop ?? null });
}

function setGoal(goal: Goal, ctx: ExtensionContext): void {
  state = { goal, list: state.list ?? [] }; // preserve the queue!
  const file = writeGoalMd(ctx.cwd, goal);
  state.goal!.activePath = path.relative(ctx.cwd, file) || file;
  persistState(ctx);
  appendLedger(ctx.cwd, "goal_created", { goalId: goal.id, objective: goal.objective, policy: goal.policy });
}

function updateGoal(patch: Partial<Goal>, ctx: ExtensionContext): void {
  if (!state.goal) return;
  state.goal = { ...state.goal, ...patch, updatedAt: nowIso() };
  const file = writeGoalMd(ctx.cwd, state.goal);
  state.goal.activePath = path.relative(ctx.cwd, file) || file;
  persistState(ctx);
}

function archiveCurrentGoal(ctx: ExtensionContext, status: Status, stopReason?: string): void {
  if (!state.goal) return;
  const goal = state.goal;
  ensureDirs(ctx.cwd);
  const target = archivedGoalPath(ctx.cwd, goal.id);
  const md = renderGoalMarkdown({ ...goal, status, stopReason });
  fs.writeFileSync(target, md);
  // Remove active md file
  try { fs.unlinkSync(goalMdPath(ctx.cwd, goal.id)); } catch {}
  state = { goal: { ...goal, status, archivedPath: path.relative(ctx.cwd, target) || target, stopReason }, list: state.list ?? [] };
  appendLedger(ctx.cwd, "goal_archived", { goalId: goal.id, status, stopReason });
  persistState(ctx);
  // Loop 2: a list-sourced goal reached a terminal state → activate the next
  // queued item. Terminal = complete or aborted (paused stays paused).
  if (goal.policy === "list" && (status === "complete" || status === "aborted")) {
    activateNextListItem(ctx);
  }
}

// =================================================================
// Loop 2: /list queue
// =================================================================

function listQueue(): NonNullable<State["list"]> {
  return state.list ?? [];
}

function activateNextListItem(ctx: ExtensionContext): boolean {
  const queue = listQueue();
  if (queue.length === 0) return false;
  const [next, ...rest] = queue;
  state = { ...state, list: rest };
  const goal = createGoal(next!.objective, ctx, "list");
  if (next!.verificationContract) goal.verificationContract = next!.verificationContract;
  setGoal(goal, ctx);
  iterationCounter = 0;
  consecutiveStuckIterations = 0;
  consecutiveErrorIterations = 0;
  ctx.ui.notify(`Next list item activated (${rest.length} remaining): ${goal.objective.slice(0, 80)}`, "info");
  scheduleContinuation(ctx, true);
  return true;
}

// =================================================================
// Drafting: /goal with no args → clarify → Confirm dialog → activate
// =================================================================

function startDrafting(ctx: ExtensionContext, target: "goal" | "list" | "loop"): void {
  draftingTarget = target;
  const prompts: Record<string, [string, string, string]> = {
    goal: ["goal-loop-draft.md", "Goal drafting", "propose_goal_draft"],
    list: ["goal-loop-draft.md", "Goal drafting (for the queue)", "propose_goal_draft"],
    loop: ["goal-loop-forever-draft.md", "Loop drafting", "propose_loop_draft"],
  };
  const [file, label, tool] = prompts[target]!;
  ctx.ui.notify(
    `${label} started. The agent will grill until the contract is concrete, then ${tool} opens a Confirm dialog. No work begins before confirmation.`,
    "info",
  );
  const tmplPath = path.resolve(__dirname, "..", "..", "prompts", file);
  let tmpl: string;
  try {
    tmpl = fs.readFileSync(tmplPath, "utf-8");
    if (target === "list") {
      tmpl = tmpl.replace("[GOAL DRAFTING]", "[GOAL DRAFTING — the confirmed goal goes into the /list QUEUE, it does not activate immediately]");
    }
  } catch {
    tmpl = `[DRAFTING] Clarify the user's ${target}, then call ${tool}.`;
  }
  try {
    extensionApi?.sendUserMessage(tmpl, { deliverAs: ctx.isIdle() ? "followUp" : "steer" });
  } catch {
    draftingTarget = null;
  }
}

// =================================================================
// /goal: bypass drafting, start now (the only entry in v0.1.0)
// =================================================================

async function cmdSet(args: string, ctx: ExtensionContext): Promise<void> {
  let raw = args.trim();
  // Users naturally quote the objective ("/goal \"do X\""); strip one layer of
  // surrounding matching quotes so they don't leak into the goal text.
  if (raw.length >= 2 && ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))) {
    raw = raw.slice(1, -1).trim();
  }
  if (!raw) {
    startDrafting(ctx, "goal");
    return;
  }
  if (isLoopActive()) {
    ctx.ui.notify("A /loop is active — /loop stop it before setting a goal.", "warning");
    return;
  }
  draftingTarget = null; // explicit objective cancels any drafting session
  const goal = createGoal(raw, ctx);
  setGoal(goal, ctx);
  // Reset counters
  iterationCounter = 0;
  consecutiveStuckIterations = 0;
  consecutiveErrorIterations = 0;
  consecutiveNoToolIterations = 0;
  ctx.ui.notify(`Goal ${goal.id} created — starting now. Auditor will verify on completion.`, "info");
  scheduleContinuation(ctx, true);
}

async function cmdStatus(ctx: ExtensionContext): Promise<void> {
  if (!state.goal) {
    ctx.ui.notify("No active goal. Use /goal <objective>.", "info");
    return;
  }
  const g = state.goal;
  const lines = [
    `[${g.id}] ${statusLabel(g.status)}`,
    `Objective: ${g.objective}`,
    `Auto-continue: ${g.autoContinue ? "on" : "off"}`,
    `Iteration: ${iterationCounter}`,
    `Tokens: ${(g.usage?.tokensUsed ?? 0).toLocaleString()} / ${(g.usage?.tokensLimit ?? 1_000_000).toLocaleString()}`,
  ];
  if (g.auditHistory && g.auditHistory.length > 0) {
    lines.push(`Audits: ${g.auditHistory.length} (${g.auditHistory.filter((v) => v.approved).length} approved)`);
  }
  if (g.pauseReason) lines.push(`Paused: ${g.pauseReason}`);
  ctx.ui.notify(lines.join("\n"), "info");
}

async function cmdPause(ctx: ExtensionContext): Promise<void> {
  if (!state.goal) return;
  updateGoal({ status: "paused" }, ctx);
  ctx.ui.notify(`Goal ${state.goal.id} paused. /goal-resume to continue.`, "info");
}

async function cmdResume(ctx: ExtensionContext): Promise<void> {
  if (!state.goal || state.goal.status !== "paused") return;
  updateGoal({ status: "active", pauseReason: undefined, pauseSuggestedAction: undefined }, ctx);
  scheduleContinuation(ctx, true);
}

async function cmdCancel(ctx: ExtensionContext): Promise<void> {
  if (!state.goal) return;
  archiveCurrentGoal(ctx, "aborted", "user cancelled");
  ctx.abort();
  ctx.ui.notify("Goal aborted.", "info");
}

async function cmdTweak(args: string, ctx: ExtensionContext): Promise<void> {
  if (!state.goal || state.goal.status !== "active") {
    ctx.ui.notify("No active goal to tweak. /goal <objective> to start one.", "info");
    return;
  }
  let raw = args.trim();
  if (raw.length >= 2 && ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))) {
    raw = raw.slice(1, -1).trim();
  }
  if (!raw) {
    ctx.ui.notify("Usage: /goal-tweak <replacement objective, optional 'Done when: ...' clause>", "info");
    return;
  }
  const current = state.goal;
  const proposed = extractVerificationContract(raw);
  const newObjective = proposed.objective;
  const newContract = proposed.verificationContract;
  let confirmed = false;
  try {
    confirmed = await ctx.ui.confirm(
      "Tweak goal?",
      `CURRENT:\n${current.objective.slice(0, 400)}\n\nNEW:\n${newObjective.slice(0, 400)}` +
      (newContract ? `\n\nNew contract:\n${newContract.slice(0, 200)}` : "\n\n(New text carries no contract; old contract is dropped.)"),
    );
  } catch {
    confirmed = false;
  }
  if (!confirmed) {
    ctx.ui.notify("Tweak cancelled; goal unchanged.", "info");
    return;
  }
  updateGoal({ objective: newObjective, verificationContract: newContract }, ctx);
  appendLedger(ctx.cwd, "goal_tweaked", { goalId: current.id, objective: newObjective });
  ctx.ui.notify("Goal tweaked. The loop continues against the new objective.", "info");
  scheduleContinuation(ctx, true);
}

// =================================================================
// /list commands (loop 2)
// =================================================================

async function cmdList(args: string, ctx: ExtensionContext): Promise<void> {
  const parts = args.trim().split(/\s+/);
  const sub = (parts[0] ?? "").toLowerCase();
  const rest = args.trim().slice(sub.length).trim();

  if (!sub || sub === "show") {
    const queue = listQueue();
    const lines: string[] = [];
    if (state.goal) {
      lines.push(`Active: [${state.goal.policy}] ${state.goal.objective.slice(0, 80)} (${statusLabel(state.goal.status)})`);
    } else {
      lines.push("Active: (none)");
    }
    if (queue.length === 0) {
      lines.push("Queue: empty. /list add <objective>");
    } else {
      lines.push(`Queue (${queue.length}):`);
      queue.forEach((item, i) => lines.push(`  ${i + 1}. ${item.objective.slice(0, 90)}`));
    }
    ctx.ui.notify(lines.join("\n"), "info");
    return;
  }

  if (sub === "add") {
    let raw = rest;
    if (raw.length >= 2 && ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))) {
      raw = raw.slice(1, -1).trim();
    }
    if (!raw) {
      // /list add with no args → draft a confirmed contract INTO THE QUEUE.
      startDrafting(ctx, "list");
      return;
    }
    const { objective, verificationContract } = extractVerificationContract(raw);
    const item = { id: newGoalId(), objective, verificationContract: verificationContract || undefined, addedAt: nowIso() };
    state = { ...state, list: [...listQueue(), item] };
    persistState(ctx);
    appendLedger(ctx.cwd, "list_added", { id: item.id, objective: item.objective });
    // Nothing active → activate immediately.
    if (!state.goal || state.goal.status === "complete" || state.goal.status === "aborted") {
      activateNextListItem(ctx);
    } else {
      ctx.ui.notify(`Queued (${listQueue().length} waiting): ${objective.slice(0, 80)}`, "info");
    }
    return;
  }

  if (sub === "clear") {
    state = { ...state, list: [] };
    persistState(ctx);
    appendLedger(ctx.cwd, "list_cleared", {});
    ctx.ui.notify("List cleared. Active goal (if any) is untouched — /goal-cancel for that.", "info");
    return;
  }

  if (sub === "next") {
    // Skip the current active goal (abort it) and activate the next queued item.
    if (state.goal && state.goal.status === "active") {
      archiveCurrentGoal(ctx, "aborted", "skipped via /list next");
    }
    if (!activateNextListItem(ctx)) {
      ctx.ui.notify("Queue is empty — nothing to advance to.", "info");
    }
    return;
  }

  if (sub === "remove" || sub === "rm") {
    const n = Number.parseInt(rest, 10);
    const queue = listQueue();
    if (!Number.isFinite(n) || n < 1 || n > queue.length) {
      ctx.ui.notify(`Usage: /list remove <1-${queue.length}>`, "info");
      return;
    }
    const removed = queue[n - 1]!;
    state = { ...state, list: queue.filter((_, i) => i !== n - 1) };
    persistState(ctx);
    appendLedger(ctx.cwd, "list_removed", { id: removed.id, objective: removed.objective });
    ctx.ui.notify(`Removed: ${removed.objective.slice(0, 80)}`, "info");
    return;
  }

  ctx.ui.notify("Usage: /list [show] | /list add <objective> | /list next | /list remove <n> | /list clear", "info");
}

/**
 * Config-gated push notification: if settings.notifyCmd is set, shell out
 * with the message as $1. Fire-and-forget — a broken notify command never
 * blocks the loop. /goal-settings notify='<cmd>' to configure.
 */
function notifyExternal(ctx: ExtensionContext, message: string): void {
  try {
    const settings = loadSettings(ctx.cwd);
    const cmd = settings.notifyCmd;
    if (!cmd || !extensionApi) return;
    void extensionApi.exec("bash", ["-c", cmd, "pi-goal-loop-audit", message], { cwd: ctx.cwd }).catch(() => {});
  } catch {
    // non-fatal by design
  }
}

// =================================================================
// Loop 3: /loop — metric-driven forever loop
//
// The anti-doorknob law: the loop only believes a number. The orchestrator
// runs the user's measure command (via pi.exec) after every agent turn;
// the agent never self-reports progress. Termination: plateau, iteration
// cap, or /loop stop. There is NO auditor in loop 3 — the metric is the
// verdict.
// =================================================================

let loopTimer: NodeJS.Timeout | null = null;

function clearLoopTimer(): void {
  if (loopTimer) {
    clearTimeout(loopTimer);
    loopTimer = null;
  }
}

function isLoopActive(): boolean {
  return !!state.loop?.active;
}

/** Run the user's measure command. Orchestrator-side, never agent-side. */
async function runMeasure(ctx: ExtensionContext, cmd: string): Promise<number | null> {
  if (!extensionApi) return null;
  try {
    const result = await extensionApi.exec("bash", ["-c", cmd], { cwd: ctx.cwd });
    const stdout = (result as any)?.stdout ?? "";
    return parseMetric(String(stdout));
  } catch {
    return null;
  }
}

/** git wrapper for branch=1 mode. Returns {ok, stdout}; never throws. */
async function runGit(ctx: ExtensionContext, args: string[]): Promise<{ ok: boolean; stdout: string }> {
  if (!extensionApi) return { ok: false, stdout: "" };
  try {
    const result = await extensionApi.exec("git", args, { cwd: ctx.cwd });
    const r = result as any;
    const code = typeof r?.code === "number" ? r.code : (r?.exitCode ?? 1);
    return { ok: code === 0, stdout: String(r?.stdout ?? "").trim() };
  } catch {
    return { ok: false, stdout: "" };
  }
}

function loopPrompt(loop: LoopState, regressionNote: string): string {
  const tmplPath = path.resolve(__dirname, "..", "..", "prompts", "goal-loop-forever.md");
  let tmpl: string;
  try {
    tmpl = fs.readFileSync(tmplPath, "utf-8");
  } catch {
    tmpl = `[LOOP ITERATION ${loop.iteration + 1}] Target: ${loop.target}. Measure: ${loop.measureCmd} (${loop.direction}). Make ONE small change to improve the metric.`;
  }
  return tmpl
    .replace(/\$\{ITERATION\}/g, String(loop.iteration + 1))
    .replace(/\$\{TARGET\}/g, loop.target)
    .replace(/\$\{MEASURE_CMD\}/g, loop.measureCmd)
    .replace(/\$\{DIRECTION\}/g, loop.direction)
    .replace(/\$\{DIRECTION_WORD\}/g, loop.direction === "min" ? "lower is better" : "higher is better")
    .replace(/\$\{LAST_VALUE\}/g, loop.lastValue === null ? "(none yet)" : String(loop.lastValue))
    .replace(/\$\{BEST_VALUE\}/g, loop.bestValue === null ? "(none yet)" : String(loop.bestValue))
    .replace(/\$\{STALL_COUNT\}/g, String(loop.stallCount))
    .replace(/\$\{PLATEAU_WINDOW\}/g, String(loop.plateauWindow))
    .replace(/\$\{REGRESSION_NOTE\}/g, regressionNote);
}

function scheduleLoopTick(ctx: ExtensionContext): void {
  if (!isLoopActive()) return;
  rememberCtx(ctx);
  clearLoopTimer();
  let delay = 0;
  try {
    delay = ctx.isIdle() && !ctx.hasPendingMessages() ? 0 : BACKOFF_IDLE_RETRY_MS;
  } catch {
    return;
  }
  loopTimer = setTimeout(() => sendLoopTurn(), delay);
  loopTimer.unref?.();
}

function sendLoopTurn(): void {
  loopTimer = null;
  if (!isLoopActive() || !extensionApi) return;
  const ctx = freshCtx();
  if (!ctx || !ctx.isIdle() || ctx.hasPendingMessages()) {
    loopTimer = setTimeout(() => sendLoopTurn(), BACKOFF_IDLE_RETRY_MS);
    loopTimer.unref?.();
    return;
  }
  const loop = state.loop!;
  const regressedLast = loop.history.length > 0 && !loop.history[loop.history.length - 1]!.improved && loop.lastValue !== null;
  const regressionNote = regressedLast
    ? "**Your last change REGRESSED the metric. Undo it first, then try a different small change.**"
    : "";
  try {
    extensionApi.sendMessage({
      customType: GOAL_EVENT_ENTRY,
      content: loopPrompt(loop, regressionNote),
      display: false,
    }, { triggerTurn: true, deliverAs: "followUp" });
  } catch {
    // stale API — next agent_end reschedules
  }
}

/** agent_end hook for loop 3: measure → judge → continue or stop. */
async function runLoopTick(ctx: ExtensionContext): Promise<void> {
  const loop = state.loop!;
  const value = await runMeasure(ctx, loop.measureCmd);
  const outcome = applyMeasurement(loop, value, nowIso());
  persistState(ctx);
  appendLedger(ctx.cwd, "loop_measured", {
    iteration: loop.iteration,
    value,
    best: loop.bestValue,
    stall: loop.stallCount,
  });
  // branch=1 mode: commit improvements, hard-reset regressions — always and
  // only on the scratch branch.
  if (loop.branchName && outcome.kind === "continue") {
    if (outcome.improved) {
      await runGit(ctx, ["add", "-A"]);
      const committed = await runGit(ctx, ["commit", "-m", `pi-gla-loop: iteration ${loop.iteration} (${loop.direction}=${loop.bestValue})`]);
      appendLedger(ctx.cwd, "loop_git", { action: "commit", iteration: loop.iteration, ok: committed.ok });
    } else {
      const reset = await runGit(ctx, ["reset", "--hard", "HEAD"]);
      appendLedger(ctx.cwd, "loop_git", { action: "reset", iteration: loop.iteration, ok: reset.ok });
    }
    persistState(ctx);
  }
  if (outcome.kind === "stop") {
    await finishLoopGit(ctx, loop);
    ctx.ui.notify(`Loop stopped: ${outcome.reason}. ${loop.history.length} iterations recorded.`, "info");
    appendLedger(ctx.cwd, "loop_stopped", { reason: outcome.reason, iterations: loop.iteration, best: loop.bestValue });
    notifyExternal(ctx, `Loop stopped: ${outcome.reason}`);
    return;
  }
  scheduleLoopTick(ctx);
}

/** On loop stop (any reason): return to the original branch, tell the user
 * where the work lives and how to merge it. Scratch branch is never deleted. */
async function finishLoopGit(ctx: ExtensionContext, loop: LoopState): Promise<void> {
  if (!loop.branchName) return;
  // Uncommitted remnants (final stalled iterations were reset already, but be safe).
  await runGit(ctx, ["reset", "--hard", "HEAD"]);
  if (loop.originalBranch) {
    await runGit(ctx, ["checkout", loop.originalBranch]);
  }
  ctx.ui.notify(
    `Loop work is on branch ${loop.branchName} (${loop.iteration} iterations, best ${loop.bestValue ?? "n/a"}).\nMerge with: git merge ${loop.branchName} — or delete with: git branch -D ${loop.branchName}`,
    "info",
  );
  appendLedger(ctx.cwd, "loop_git", { action: "finish", branch: loop.branchName, returnedTo: loop.originalBranch });
}

async function cmdLoop(args: string, ctx: ExtensionContext): Promise<void> {
  const parts = args.trim().split(/\s+/);
  const sub = (parts[0] ?? "").toLowerCase();
  const rest = args.trim().slice(sub.length).trim();

  if (!sub) {
    // /loop with no args → draft the loop config (metric design is the whole
    // game for a long-running loop; never start one blind).
    if (isLoopActive()) {
      ctx.ui.notify("A loop is already active — /loop status to inspect, /loop stop to end it.", "info");
      return;
    }
    startDrafting(ctx, "loop");
    return;
  }

  if (sub === "status") {
    const loop = state.loop;
    if (!loop) {
      ctx.ui.notify("No loop. /loop to draft one, or /loop start \"<target>\" measure=\"<cmd>\" direction=min|max [window=5] [max=50]", "info");
      return;
    }
    const lines = [
      `Loop: ${loop.active ? "active" : "stopped"} — ${loop.target.slice(0, 80)}`,
      `Metric: ${loop.measureCmd} (${loop.direction})`,
      `Iteration ${loop.iteration}/${loop.maxIterations} · best ${loop.bestValue ?? "n/a"} · last ${loop.lastValue ?? "n/a"} · stall ${loop.stallCount}/${loop.plateauWindow}`,
    ];
    if (loop.stopReason) lines.push(`Stopped: ${loop.stopReason}`);
    const tail = loop.history.slice(-5);
    if (tail.length > 0) {
      lines.push("Recent: " + tail.map((h) => `${h.value ?? "ERR"}${h.improved ? "↑" : ""}`).join(" "));
    }
    ctx.ui.notify(lines.join("\n"), "info");
    return;
  }

  if (sub === "start") {
    if (state.goal && state.goal.status === "active") {
      ctx.ui.notify("A goal is active — /goal-cancel or /goal-pause it before starting a loop.", "warning");
      return;
    }
    if (isLoopActive()) {
      ctx.ui.notify("A loop is already active. /loop stop first.", "warning");
      return;
    }
    let cfg;
    try {
      cfg = parseLoopStartArgs(rest);
    } catch (err) {
      ctx.ui.notify(`/loop start: ${err instanceof Error ? err.message : String(err)}`, "warning");
      return;
    }
    // branch=1 mode: scratch branch ONLY. Refuse on non-git or dirty tree —
    // we never mix uncommitted user work into the loop's branch.
    let branchName: string | undefined;
    let originalBranch: string | undefined;
    if (cfg.branch) {
      const isRepo = await runGit(ctx, ["rev-parse", "--is-inside-work-tree"]);
      if (!isRepo.ok) {
        ctx.ui.notify("branch=1 requires a git repository.", "warning");
        return;
      }
      const dirty = await runGit(ctx, ["status", "--porcelain"]);
      if (!dirty.ok || dirty.stdout.length > 0) {
        ctx.ui.notify("branch=1 requires a clean working tree — commit or stash your changes first.", "warning");
        return;
      }
      const current = await runGit(ctx, ["rev-parse", "--abbrev-ref", "HEAD"]);
      originalBranch = current.ok ? current.stdout : undefined;
      branchName = loopBranchName(nowIso(), cfg.target);
      const created = await runGit(ctx, ["checkout", "-b", branchName]);
      if (!created.ok) {
        ctx.ui.notify(`Failed to create scratch branch ${branchName}.`, "warning");
        return;
      }
    }
    // Baseline measurement before the first agent turn.
    const baseline = await runMeasure(ctx, cfg.measureCmd);
    state = {
      ...state,
      loop: {
        target: cfg.target,
        measureCmd: cfg.measureCmd,
        direction: cfg.direction,
        iteration: 0,
        maxIterations: cfg.maxIterations,
        plateauWindow: cfg.plateauWindow,
        stallCount: 0,
        bestValue: baseline,
        lastValue: baseline,
        active: true,
        history: [],
        startedAt: nowIso(),
        branchName,
        originalBranch,
      },
    };
    persistState(ctx);
    appendLedger(ctx.cwd, "loop_started", { target: cfg.target, measureCmd: cfg.measureCmd, direction: cfg.direction, baseline, branch: branchName });
    ctx.ui.notify(
      `Loop started: ${cfg.target.slice(0, 60)}\nBaseline: ${baseline ?? "(measure produced no number — first turn must fix that)"} · direction ${cfg.direction} · window ${cfg.plateauWindow} · max ${cfg.maxIterations}` +
      (branchName ? `\nbranch mode: committing improvements to ${branchName}` : ""),
      "info",
    );
    scheduleLoopTick(ctx);
    return;
  }

  if (sub === "stop") {
    if (!state.loop) {
      ctx.ui.notify("No loop to stop.", "info");
      return;
    }
    clearLoopTimer();
    state.loop = { ...state.loop, active: false, stopReason: state.loop.stopReason ?? "stopped by user (/loop stop)" };
    persistState(ctx);
    await finishLoopGit(ctx, state.loop);
    appendLedger(ctx.cwd, "loop_stopped", { reason: "user", iterations: state.loop.iteration, best: state.loop.bestValue });
    ctx.ui.notify(
      `Loop stopped after ${state.loop.iteration} iterations. Best: ${state.loop.bestValue ?? "n/a"}.`,
      "info",
    );
    notifyExternal(ctx, `Loop stopped by user after ${state.loop.iteration} iterations (best: ${state.loop.bestValue ?? "n/a"})`);
    return;
  }

  ctx.ui.notify("Usage: /loop [status] | /loop start \"<target>\" measure=\"<cmd>\" direction=min|max [window=5] [max=50] | /loop stop", "info");
}

// =================================================================
// Tools exposed to the agent
// =================================================================

function registerAgentTools(pi: any, ctx: ExtensionContext): void {
  pi.registerTool(defineTool({
    name: "complete_goal",
    label: "Complete goal",
    description: "Mark the active goal as complete. Spawns an isolated auditor to verify. Use only when the objective is genuinely satisfied.",
    parameters: Type.Object({
      completionSummary: Type.Optional(Type.String({ description: "1-paragraph completion claim" })),
      verificationSummary: Type.Optional(Type.String({ description: "Per-item evidence for the verification contract" })),
    }),
    async execute(_id, params, signal) {
      if (!state.goal || state.goal.status !== "active") {
        return { content: [{ type: "text", text: "No active goal." }], details: {} };
      }
      const p = params as { completionSummary?: string; verificationSummary?: string };
      updateGoal({ status: "auditing" }, ctx);
      const settings = loadSettings(ctx.cwd);
      const { model: auditorModel, error: modelError } = resolveAuditorModel(ctx, settings.auditorModel);
      if (modelError) {
        ctx.ui.notify(`Auditor model issue: ${modelError} — falling back to session model.`, "warning");
      }
      ctx.ui.notify("Auditor running (isolated session)…", "info");
      // Esc during the audit aborts this tool's signal → threaded into the
      // auditor session, which aborts cleanly and returns "Auditor aborted."
      const result = await runGoalCompletionAuditor({
        ctx,
        goal: state.goal,
        completionSummary: p.completionSummary,
        verificationSummary: p.verificationSummary,
        model: auditorModel,
        thinkingLevel: settings.auditorThinkingLevel,
        signal: signal ?? undefined,
      });
      // Audit history: record REAL verdicts only — a non-empty report is the
      // evidence the auditor actually inspected something. Empty-report runs
      // (abort, auth failure, no model) are surfaced via pauseReason, not
      // logged as disapprovals.
      const auditorRan = result.output.trim().length > 0;
      const history = state.goal.auditHistory ?? [];
      if (auditorRan) {
        history.push({
          at: nowIso(),
          approved: result.approved,
          disapproved: result.disapproved,
          model: result.model,
          thinkingLevel: result.thinkingLevel,
          report: result.output,
          error: result.error,
          regressionShieldPassed: result.regressionShieldPassed,
        });
        // Cap history — 39 infra errors taught us unbounded growth is real.
        if (history.length > 20) history.splice(0, history.length - 20);
      }

      // Escape hatch: the user aborted the audit (Esc). Offer the explicit
      // choice — complete WITHOUT audit, or keep working. (pi-goal-x parity.)
      if (result.error === "Auditor aborted.") {
        updateGoal({ status: "active", auditHistory: history, pauseReason: "audit aborted by user (Esc)" }, ctx);
        let completeAnyway = false;
        try {
          completeAnyway = await ctx.ui.confirm(
            "Audit aborted",
            "You aborted the auditor (Escape).\n\nYes = mark the goal COMPLETE WITHOUT AUDIT (you take responsibility for verification).\nNo = continue working; the auditor will verify on the next complete_goal.",
          );
        } catch {
          completeAnyway = false;
        }
        if (completeAnyway) {
          updateGoal({ auditHistory: history }, ctx);
          archiveCurrentGoal(ctx, "complete", "completed without audit (user choice after Esc)");
          return { content: [{ type: "text", text: "Goal marked complete without audit (user choice)." }], details: {} };
        }
        scheduleContinuation(ctx, true);
        return {
          content: [{ type: "text", text: "Audit aborted; continuing. Call complete_goal again when ready — the auditor will re-run." }],
          details: {},
        };
      }

      if (result.approved) {
        updateGoal({ auditHistory: history }, ctx);
        const objective = state.goal.objective;
        archiveCurrentGoal(ctx, "complete", `auditor ${result.model} approved`);
        notifyExternal(ctx, `Goal complete (auditor approved): ${objective.slice(0, 120)}`);
        return { content: [{ type: "text", text: `Goal approved by auditor ${result.model}.` }], details: {} };
      } else {
        updateGoal({
          status: "active",
          auditHistory: history,
          pauseReason: result.error ? `auditor errored: ${result.error}` : "auditor disapproved",
          pauseSuggestedAction: "Inspect auditor feedback and fix the actual gap before calling complete_goal again",
        }, ctx);
        scheduleContinuation(ctx, true);
        return {
          content: [{
            type: "text",
            text: `Auditor disapproved. Reason: ${result.error || "see history"}.\nReport (first 800 chars):\n${result.output.slice(0, 800)}`,
          }],
          details: {},
        };
      }
    },
  }));

  pi.registerTool(defineTool({
    name: "pause_goal",
    label: "Pause goal",
    description: "Pause the active goal with a reason and suggested action. Use when blocked on user input or unable to make progress.",
    parameters: Type.Object({
      reason: Type.String({ description: "Why the work is paused" }),
      suggestedAction: Type.Optional(Type.String({ description: "What the user should do next" })),
    }),
    async execute(_id, params) {
      const p = params as { reason: string; suggestedAction?: string };
      if (!state.goal) return { content: [{ type: "text", text: "No active goal." }], details: {} };
      updateGoal({
        status: "paused",
        pauseReason: p.reason,
        pauseSuggestedAction: p.suggestedAction,
      }, ctx);
      ctx.ui.notify(`Goal paused: ${p.reason}`, "info");
      notifyExternal(ctx, `Goal paused: ${p.reason.slice(0, 120)}`);
      return { content: [{ type: "text", text: "Goal paused. /goal-resume to continue." }], details: {} };
    },
  }));

  pi.registerTool(defineTool({
    name: "complete_task",
    label: "Complete task",
    description: "Mark a task in the active goal's task list as complete (does not stop the turn).",
    parameters: Type.Object({
      id: Type.String({ description: "Task id to complete" }),
    }),
    async execute(_id, params) {
      const p = params as { id: string };
      if (!state.goal || !state.goal.taskList) {
        return { content: [{ type: "text", text: "No task list in this goal." }], details: {} };
      }
      const tl = state.goal.taskList;
      const queue: any[] = [...tl.tasks];
      while (queue.length > 0) {
        const t = queue.shift();
        if (t.id === p.id && t.status !== "complete") {
          t.status = "complete";
          updateGoal({ taskList: tl }, ctx);
          return { content: [{ type: "text", text: `Task ${p.id} marked complete.` }], details: {} };
        }
        if (t.subtasks) queue.push(...t.subtasks);
      }
      return { content: [{ type: "text", text: `Task ${p.id} not found.` }], details: {} };
    },
  }));

  pi.registerTool(defineTool({
    name: "update_task_status",
    label: "Update task status",
    description: "Update a task's status (pending/in_progress/complete).",
    parameters: Type.Object({
      id: Type.String(),
      status: Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("complete")]),
    }),
    async execute(_id, params) {
      const p = params as { id: string; status: "pending" | "in_progress" | "complete" };
      if (!state.goal || !state.goal.taskList) {
        return { content: [{ type: "text", text: "No task list in this goal." }], details: {} };
      }
      const tl = state.goal.taskList;
      const queue: any[] = [...tl.tasks];
      while (queue.length > 0) {
        const t = queue.shift();
        if (t.id === p.id) {
          t.status = p.status;
          updateGoal({ taskList: tl }, ctx);
          return { content: [{ type: "text", text: `Task ${p.id} → ${p.status}` }], details: {} };
        }
        if (t.subtasks) queue.push(...t.subtasks);
      }
      return { content: [{ type: "text", text: `Task ${p.id} not found.` }], details: {} };
    },
  }));

  pi.registerTool(defineTool({
    name: "propose_goal_draft",
    label: "Propose goal draft",
    description: "During goal drafting (/goal with no args), propose the clarified goal contract. Opens the user's Confirm dialog — nothing activates until they confirm.",
    parameters: Type.Object({
      objective: Type.String({ description: "The clarified, concrete objective" }),
      verificationContract: Type.Optional(Type.String({ description: "Checkable done-criteria (commands, file states, test outcomes)" })),
    }),
    async execute(_id, params, _signal, _onUpdate, execCtx) {
      const p = params as { objective: string; verificationContract?: string };
      if (draftingTarget !== "goal" && draftingTarget !== "list") {
        return {
          content: [{ type: "text", text: "Not in goal drafting mode. The user starts drafting with /goal or /list add (no args), or activates directly with /goal <objective>." }],
          details: {},
        };
      }
      const liveCtx = (execCtx as ExtensionContext | undefined) ?? ctx;
      const contractBlock = p.verificationContract?.trim()
        ? `\n\nDone when:\n${p.verificationContract.trim()}`
        : "\n\n(No verification contract — the auditor will infer done-criteria from the objective. Consider adding one.)";
      let confirmed = false;
      try {
        confirmed = await liveCtx.ui.confirm("Confirm goal", `${p.objective.trim()}${contractBlock}`);
      } catch {
        confirmed = false;
      }
      if (!confirmed) {
        return {
          content: [{ type: "text", text: "Draft rejected by the user. Ask what to change, refine, and propose again. Do not repeat the identical draft." }],
          details: {},
        };
      }
      const confirmedTarget = draftingTarget;
      draftingTarget = null;
      const full = p.objective.trim() + (p.verificationContract?.trim() ? `\nDone when:\n${p.verificationContract.trim()}` : "");
      // List drafting: the confirmed contract goes into the QUEUE, not active.
      if (confirmedTarget === "list") {
        const extracted = extractVerificationContract(full);
        const item = { id: newGoalId(), objective: extracted.objective, verificationContract: extracted.verificationContract || undefined, addedAt: nowIso() };
        state = { ...state, list: [...listQueue(), item] };
        persistState(liveCtx);
        appendLedger(liveCtx.cwd, "list_added", { id: item.id, objective: item.objective, drafted: true });
        if (!state.goal || state.goal.status === "complete" || state.goal.status === "aborted") {
          activateNextListItem(liveCtx);
          return { content: [{ type: "text", text: "Confirmed and activated (queue was empty). Begin work now." }], details: {} };
        }
        return { content: [{ type: "text", text: `Confirmed and queued (${listQueue().length} waiting). It activates when the current goal completes.` }], details: {} };
      }
      const goal = createGoal(full, liveCtx);
      setGoal(goal, liveCtx);
      iterationCounter = 0;
      consecutiveStuckIterations = 0;
      consecutiveErrorIterations = 0;
      scheduleContinuation(liveCtx, true);
      return {
        content: [{ type: "text", text: `Goal confirmed and activated (id ${goal.id}). Begin work now; call complete_goal only when the objective is genuinely satisfied.` }],
        details: {},
      };
    },
  }));

  pi.registerTool(defineTool({
    name: "propose_task_list",
    label: "Propose task list",
    description: "Propose a task breakdown for the active goal. Opens the user's Confirm dialog. Limits: 20 top-level tasks, 5 subtasks per task.",
    parameters: Type.Object({
      tasks: Type.Array(Type.Object({
        title: Type.String(),
        subtasks: Type.Optional(Type.Array(Type.String())),
      })),
    }),
    async execute(_id, params, _signal, _onUpdate, execCtx) {
      if (!state.goal || state.goal.status !== "active") {
        return { content: [{ type: "text", text: "No active goal to break down." }], details: {} };
      }
      if (state.goal.taskList && state.goal.taskList.tasks.length > 0) {
        return { content: [{ type: "text", text: "A task list already exists. Use update_task_status / complete_task to work it." }], details: {} };
      }
      const p = params as { tasks: TaskProposal[] };
      const invalid = validateTaskProposal(p.tasks);
      if (invalid) {
        return { content: [{ type: "text", text: invalid }], details: {} };
      }
      const liveCtx = (execCtx as ExtensionContext | undefined) ?? ctx;
      const preview = p.tasks.map((t, i) => {
        const subs = (t.subtasks ?? []).map((s, j) => `   ${i + 1}.${j + 1} ${s}`).join("\n");
        return `${i + 1}. ${t.title}` + (subs ? `\n${subs}` : "");
      }).join("\n");
      let confirmed = false;
      try {
        confirmed = await liveCtx.ui.confirm("Confirm task list", preview);
      } catch {
        confirmed = false;
      }
      if (!confirmed) {
        return { content: [{ type: "text", text: "Task list rejected by the user. Adjust and propose again." }], details: {} };
      }
      const taskList = buildTaskList(p.tasks);
      updateGoal({ taskList }, liveCtx);
      const subCount = taskList.tasks.reduce((n, t) => n + (t.subtasks?.length ?? 0), 0);
      return {
        content: [{ type: "text", text: `Task list set: ${taskList.tasks.length} tasks, ${subCount} subtasks. Track progress with complete_task / update_task_status.` }],
        details: {},
      };
    },
  }));
}

// =================================================================
// Settings (auditor model, thinking level)
// =================================================================

interface Settings {
  /** "provider/model-id" or bare "model-id". Unset → session model. */
  auditorModel?: string;
  auditorThinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  /** Shell command run on goal complete / goal pause / loop stop; message passed as $1. */
  notifyCmd?: string;
  /** Per-goal token budget; crossing it pauses the goal. Default 1,000,000. */
  tokenLimit?: number;
}

const DEFAULT_SETTINGS: Settings = {
  auditorThinkingLevel: "medium",
};

function settingsPath(cwd: string): string {
  return path.join(piGlaDir(cwd), "settings.json");
}

function loadSettings(cwd: string): Settings {
  const file = settingsPath(cwd);
  if (!fs.existsSync(file)) return { ...DEFAULT_SETTINGS };
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(file, "utf-8")) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * Resolve the auditor model from settings. Unset → ctx.model (session model).
 * "provider/id" → exact registry lookup. Bare "id" → first available match.
 * IMPORTANT: the auditor runs in an extension-less session, so only built-in
 * providers work there. Extension-provided models (e.g. kilocode on this rig)
 * fail inside the auditor — pick a built-in provider for auditorModel.
 */
function resolveAuditorModel(ctx: ExtensionContext, ref?: string): { model: any; error?: string } {
  if (!ref || !ref.trim()) return { model: undefined }; // auditor falls back to ctx.model
  const trimmed = ref.trim();
  const slash = trimmed.indexOf("/");
  if (slash > 0) {
    const provider = trimmed.slice(0, slash);
    const id = trimmed.slice(slash + 1);
    const model = ctx.modelRegistry.find(provider, id);
    return model ? { model } : { model: undefined, error: `model not found: ${trimmed}` };
  }
  const matches = ctx.modelRegistry.getAvailable().filter((m: any) => m.id === trimmed || m.name === trimmed);
  return matches[0] ? { model: matches[0] } : { model: undefined, error: `no available model matching: ${trimmed}` };
}

async function cmdSettings(args: string, ctx: ExtensionContext): Promise<void> {
  // Arg-based (works everywhere, incl. tmux/headless):
  //   /goal-settings model=opencode/deepseek-v4-flash-free
  //   /goal-settings thinking=high
  //   /goal-settings            (show current)
  const s = loadSettings(ctx.cwd);
  const trimmed = args.trim();
  if (!trimmed) {
    ctx.ui.notify(
      `auditorModel: ${s.auditorModel ?? "(unset — session model)"}\n` +
      `auditorThinkingLevel: ${s.auditorThinkingLevel ?? "medium"}\n` +
      `Set with: /goal-settings model=provider/id thinking=low|medium|high`,
      "info",
    );
    return;
  }
  const next = { ...s };
  let changed = false;
  // Quote-aware key=value parsing: notify='echo $1 >> /tmp/log' must survive
  // with its spaces intact (naive whitespace splitting mangled it to "'echo").
  const kvRe = /(\w+)=(?:"([^"]*)"|'([^']*)'|(\S+))/g;
  let m: RegExpExecArray | null;
  while ((m = kvRe.exec(trimmed)) !== null) {
    const key = m[1]!.toLowerCase();
    const value = m[2] ?? m[3] ?? m[4] ?? "";
    if (key === "model" || key === "auditormodel") {
      next.auditorModel = value === "unset" ? undefined : value;
      changed = true;
    } else if (key === "notify" || key === "notifycmd") {
      next.notifyCmd = value === "unset" ? undefined : value;
      changed = true;
    } else if (key === "tokenlimit") {
      const n = Number.parseInt(value, 10);
      if (Number.isFinite(n) && n > 0) {
        next.tokenLimit = n;
        changed = true;
      } else {
        ctx.ui.notify(`tokenlimit must be a positive integer, got: ${value}`, "warning");
      }
    } else if (key === "thinking" || key === "auditorthinkinglevel") {
      if (["off", "minimal", "low", "medium", "high", "xhigh"].includes(value)) {
        next.auditorThinkingLevel = value as Settings["auditorThinkingLevel"];
        changed = true;
      } else {
        ctx.ui.notify(`Unknown thinking level: ${value}`, "warning");
      }
    }
  }
  if (!changed) {
    ctx.ui.notify("Nothing changed. Use model=provider/id or thinking=low|medium|high.", "info");
    return;
  }
  ensureDirs(ctx.cwd);
  fs.writeFileSync(settingsPath(ctx.cwd), JSON.stringify(next, null, 2));
  ctx.ui.notify(
    `Saved. auditorModel=${next.auditorModel ?? "(session model)"} thinking=${next.auditorThinkingLevel ?? "medium"} notify=${next.notifyCmd ?? "(off)"}\n` +
    `Note: the auditor runs without extensions — choose a built-in provider (opencode, openrouter, minimax, …), not an extension-registered one.`,
    "info",
  );
}

// =================================================================
// Command-collision detector (PLAN.md D1)
//
// pi's runner.js resolveRegisteredCommands() never throws on duplicate
// command names: the first registrant keeps the bare name, later ones
// become "goal:2", "list:3", etc. So a collision degrades UX silently.
// We detect duplicates at session start and warn loudly once.
// =================================================================

const OUR_COMMANDS = ["goal", "goal-status", "goal-pause", "goal-resume", "goal-cancel", "goal-tweak", "goal-settings", "list", "loop"];
let collisionWarned = false;

// Providers verified to exist in a bare (extension-less) session. The auditor
// spawns exactly such a session, so extension-registered providers (kilocode,
// zenmux on this rig) fail inside it. Unknown providers get a soft one-time
// notice — not an error, since the built-in set grows over time.
const KNOWN_BUILTIN_PROVIDERS = new Set([
  "anthropic", "google", "google-vertex", "google-gemini-cli", "openai", "openai-codex",
  "openrouter", "opencode", "azure-openai-responses", "groq", "cerebras", "xai", "zai",
  "minimax", "minimax-cn", "moonshotai", "kimi-coding", "github-copilot", "mistral", "huggingface",
]);
let providerWarned = false;

function warnIfAuditorProviderRisky(ctx: ExtensionContext): void {
  if (providerWarned) return;
  providerWarned = true;
  try {
    const settings = loadSettings(ctx.cwd);
    if (settings.auditorModel) return; // explicit auditor model — user's call
    const provider = (ctx.model as any)?.provider as string | undefined;
    if (!provider || KNOWN_BUILTIN_PROVIDERS.has(provider)) return;
    ctx.ui.notify(
      `pi-goal-loop-audit: session model provider "${provider}" may be extension-registered. The auditor runs in an extension-less session and may fail auth. If audits error, set a built-in model: /goal-settings model=opencode/deepseek-v4-flash-free`,
      "warning",
    );
  } catch {
    // non-fatal by design
  }
}

function warnOnCommandCollision(ctx: ExtensionContext): void {
  if (collisionWarned) return;
  collisionWarned = true;
  try {
    if (!extensionApi) return;
    const counts = new Map<string, number>();
    for (const cmd of extensionApi.getCommands() as any[]) {
      const name = String(cmd.invocationName ?? cmd.name ?? "").split(":")[0] ?? "";
      if (OUR_COMMANDS.includes(name)) {
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
    }
    const dupes = [...counts.entries()].filter(([, n]) => n > 1).map(([n]) => `/${n}`);
    if (dupes.length > 0) {
      const first = dupes[0] ?? "goal";
      ctx.ui.notify(
        `pi-goal-loop-audit: command collision on ${dupes.join(", ")}. Another extension registered the same name; ours may be reachable as /${first.slice(1)}:2. Consider disabling the other plugin.`,
        "warning",
      );
    }
  } catch {
    // getCommands unavailable or shape changed — stay silent, collision is non-fatal.
  }
}

// =================================================================
// Public extension entry
// =================================================================

export default function (pi: ExtensionAPI): void {
  extensionApi = pi;
  startHeartbeat();
  pi.registerCommand("goal", {
    description: "Set a goal and start the loop now (no drafting). /goal <objective> [Done when: <verifier>]",
    handler: (args: string, ctx: ExtensionContext) => { rememberCtx(ctx); return cmdSet(args, ctx); },
  });
  pi.registerCommand("goal-status", {
    description: "Show current goal state.",
    handler: (_args: string, ctx: ExtensionContext) => { rememberCtx(ctx); return cmdStatus(ctx); },
  });
  pi.registerCommand("goal-pause", {
    description: "Pause the current goal.",
    handler: (_args: string, ctx: ExtensionContext) => { rememberCtx(ctx); return cmdPause(ctx); },
  });
  pi.registerCommand("goal-resume", {
    description: "Resume the current goal.",
    handler: (_args: string, ctx: ExtensionContext) => { rememberCtx(ctx); return cmdResume(ctx); },
  });
  pi.registerCommand("goal-cancel", {
    description: "Abort the current goal.",
    handler: (_args: string, ctx: ExtensionContext) => { rememberCtx(ctx); return cmdCancel(ctx); },
  });
  pi.registerCommand("goal-tweak", {
    description: "Edit the active goal's objective in place (Confirm dialog). /goal-tweak <new objective>",
    handler: (args: string, ctx: ExtensionContext) => { rememberCtx(ctx); return cmdTweak(args, ctx); },
  });
  pi.registerCommand("goal-settings", {
    description: "Configure auditor model + thinking level (interactive prompt).",
    handler: (args: string, ctx: ExtensionContext) => { rememberCtx(ctx); return cmdSettings(args, ctx); },
  });
  pi.registerCommand("list", {
    description: "Loop 2: queue of goals. /list add <obj> | /list show | /list next | /list remove <n> | /list clear",
    handler: (args: string, ctx: ExtensionContext) => { rememberCtx(ctx); return cmdList(args, ctx); },
  });
  pi.registerCommand("loop", {
    description: "Loop 3: metric-driven forever loop. /loop start \"<target>\" measure=\"<cmd>\" direction=min|max [window=5] [max=50] | /loop status | /loop stop",
    handler: (args: string, ctx: ExtensionContext) => { rememberCtx(ctx); return cmdLoop(args, ctx); },
  });

  // Tool registration is done after first command so the context is available.
  // For v0.1.0 we register at load; we accept that tools show even without an
  // active goal (and return "no active goal" if called).
  let registeredCtx: ExtensionContext | null = null;
  pi.registerCommand("goal-init", {
    description: "Internal: register agent tools. Called once at session start.",
    handler: async (_args: string, ctx: ExtensionContext) => {
      rememberCtx(ctx);
      if (!registeredCtx) {
        registerAgentTools(pi, ctx);
        registeredCtx = ctx;
      }
    },
  });

  pi.on("session_start", async (_event: any, ctx: ExtensionContext) => {
    rememberCtx(ctx);
    state = readState(ctx.cwd);
    if (!registeredCtx) {
      registerAgentTools(pi, ctx);
      registeredCtx = ctx;
    }
    warnOnCommandCollision(ctx);
    warnIfAuditorProviderRisky(ctx);
    // Resumption notice: make persisted supervisor state visible on startup.
    if (isLoopActive()) {
      const l = state.loop!;
      ctx.ui.notify(
        `Resuming loop (iteration ${l.iteration}/${l.maxIterations}, best ${l.bestValue ?? "n/a"}, stall ${l.stallCount}/${l.plateauWindow}): ${l.target.slice(0, 60)}`,
        "info",
      );
    } else if (state.goal && state.goal.status === "active") {
      ctx.ui.notify(
        `Resuming goal [${state.goal.id}]: ${state.goal.objective.slice(0, 70)}${listQueue().length > 0 ? ` (+${listQueue().length} queued)` : ""}`,
        "info",
      );
    }
    if (isLoopActive()) {
      // Session restarted mid-loop: resume measuring from persisted state.
      scheduleLoopTick(ctx);
    } else if (state.goal && state.goal.status === "active" && state.goal.autoContinue) {
      scheduleContinuation(ctx, true);
    } else if ((!state.goal || state.goal.status === "complete" || state.goal.status === "aborted") && listQueue().length > 0) {
      // Session restarted with a non-empty queue but no active goal.
      activateNextListItem(ctx);
    }
  });

  pi.on("agent_end", async (event: any, ctx: ExtensionContext) => {
    rememberCtx(ctx);
    noteActivity();
    if (!registeredCtx) {
      registerAgentTools(pi, ctx);
      registeredCtx = ctx;
    }
    // Nudge accounting: a supervising turn with zero tool calls is a nudge
    // (no real progress); 3 consecutive → pause. Tool-use turns reset it.
    if (isSupervising()) {
      heartbeatNudges = accountTurnForNudges(toolCallsThisTurn, heartbeatNudges);
      if (heartbeatNudges >= HEARTBEAT_MAX_NUDGES) {
        heartbeatNudges = 0;
        if (isLoopActive()) {
          clearLoopTimer();
          state.loop = { ...state.loop!, active: false, stopReason: `stalled: ${HEARTBEAT_MAX_NUDGES} consecutive turns with no tool calls` };
          persistState(ctx);
          ctx.ui.notify(`Loop stopped: stalled (${HEARTBEAT_MAX_NUDGES} turns, no tools). /loop start to begin a new one.`, "warning");
          notifyExternal(ctx, "Loop stopped: stalled (no tool calls).");
          return;
        }
        if (state.goal) {
          updateGoal({
            status: "paused",
            pauseReason: `stalled: ${HEARTBEAT_MAX_NUDGES} consecutive turns with no tool calls`,
            pauseSuggestedAction: "Inspect the goal — /goal-resume to retry, /goal-tweak to narrow it, /goal-cancel to abort.",
          }, ctx);
          ctx.ui.notify(`Goal paused: stalled (${HEARTBEAT_MAX_NUDGES} turns, no tools).`, "warning");
          notifyExternal(ctx, "Goal paused: stalled (no tool calls).");
          return;
        }
      }
    }
    toolCallsThisTurn = 0;
    // Loop 3 runs on the same heartbeat: measure after every agent turn.
    if (isLoopActive()) {
      clearLoopTimer();
      await runLoopTick(ctx);
      return;
    }
    if (!state.goal) return;
    if (state.goal.status !== "active") return;
    clearContinuationTimer();

    const last = [...(event.messages as any[])].reverse().find((m) => m.role === "assistant");
    const text = last && Array.isArray(last.content) ? last.content.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n") : "";
    const stopReason = last?.stopReason;
    iterationCounter++;

    // Token accounting + cost guard: accumulate this turn's assistant tokens
    // (deduped — agent_end may replay seen messages). Crossing the goal's
    // token limit pauses it; /goal-settings tokenlimit=<n> to raise.
    const newTokens = sumNewAssistantTokens(event.messages as unknown[], countedTokenMessages);
    if (newTokens > 0) {
      const used = (state.goal.usage?.tokensUsed ?? 0) + newTokens;
      const limit = state.goal.usage?.tokensLimit ?? 1_000_000;
      if (used > limit) {
        updateGoal({
          usage: { tokensUsed: used, tokensLimit: limit },
          status: "paused",
          pauseReason: `token limit exceeded (${used.toLocaleString()} > ${limit.toLocaleString()})`,
          pauseSuggestedAction: "/goal-settings tokenlimit=<n> to raise the cap, then /goal-resume",
        }, ctx);
        ctx.ui.notify(`Goal paused: token limit exceeded (${used.toLocaleString()} > ${limit.toLocaleString()}).`, "warning");
        notifyExternal(ctx, `Goal paused: token limit exceeded (${used} > ${limit}).`);
        return;
      }
      updateGoal({ usage: { tokensUsed: used, tokensLimit: limit } }, ctx);
    }

    if (stopReason === "error" || stopReason === "aborted") {
      consecutiveErrorIterations++;
      if (consecutiveErrorIterations >= 5) {
        updateGoal({
          status: "paused",
          pauseReason: `5 consecutive errors: ${stopReason}`,
          pauseSuggestedAction: "Use /goal-resume to retry, or /goal-cancel to abort.",
        }, ctx);
        ctx.ui.notify("Goal paused: 5 consecutive errors.", "warning");
        notifyExternal(ctx, "Goal paused: 5 consecutive errors.");
        return;
      }
    } else {
      consecutiveErrorIterations = 0;
    }

    // Hard 5-min cap: if no successful continue for >5 min, pause.
    // For v0.1.0 we only detect this on agent_end; a tighter watchdog lands in v0.2.0.
    // We schedule the next continuation; if it produces nothing useful in 5 min,
    // the next agent_end iteration of THIS branch will trigger the cap.

    scheduleContinuation(ctx, false);
  });

  pi.on("tool_call", () => {
    toolCallsThisTurn++;
    noteActivity();
  });
}
