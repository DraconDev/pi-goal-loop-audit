/**
 * pi-goal-list-loop-audit — v0.1.0
 * extensions/loops/goal.ts
 *
 * The goal loop. The agent continues working, and on complete_goal,
 * an isolated auditor verifies the work.
 *
 * Design: see docs/DESIGN.md.
 *
 * Command surface (v0.8.0 — four top-level commands):
 *   /goal "<objective>" | /goal (draft) | /goal status|pause|resume|cancel|tweak <text>|archive
 *   /list add|show|next|remove|clear
 *   /loop (draft) | /loop start|status|stop
 *   /glla (settings UI) | /glla key=value | /glla project key=value
 */

import * as fs from "node:fs";
import * as os from "node:os";
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
  DEFAULT_TOKEN_LIMIT,
  mergeSettings,
  parseListImport,

  routeGoalArgs,
  routeListText,
  listMutationBlocked,
  LIST_DRAFTING_BLOCK_MESSAGE,
  sumNewAssistantTokens,
  takeAt,
  goalArgsNeedDrafting,
  buildSeedGrillMessage,
  askUserQuestionAnswered,
  draftProposalBlock,
  type TaskProposal,
  validateTaskProposal,
  cloneGoal,
  ensureDirs,
  findNextPendingTask,
  goalMdPath,
  newGoalId,
  nowIso,
  piGlaDir,
  normalizeDraftContract,
  draftContractItemCount,
  readState,
  renderGoalMarkdown,
  shouldAutoResumeOnSessionStart,
  statusLabel,
  writeGoalMd,
} from "../goal-loop-core.js";
import { runGoalCompletionAuditor } from "../goal-loop-auditor.js";
import { buildStatusText, buildWidgetLines, type AuditDisplayProgress } from "../goal-loop-display.js";
import {
  applyMeasurement,
  applyMetriclessTick,
  applyRefinement,
  loopBranchName,
  parseLoopStartArgs,
  parseMetric,
  type LoopState,
} from "../goal-loop-forever.js";
import {
  accountTurnForNudges,
  BACKOFF_IDLE_RETRY_MS,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_MAX_NUDGES,
  HEARTBEAT_STALL_MS,
  shouldHeartbeatRefire,
  MEASURE_TIMEOUT_MS,
  WEDGE_ALERT_DEFAULT_MINUTES,
  shouldWedgeAlert,
} from "../goal-loop-backoff.js";

// =================================================================
// Constants
// =================================================================

const GOAL_EVENT_ENTRY = "goal-event";
/** stopReason marker for a loop held (not stopped) by the fresh-session restore gate. */
const HELD_ON_RESTORE = "held: restored in a fresh session";

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
// v0.14.0 drafting floor: user replies counted while drafting; the injected
// seed prompt itself arrives as a user message — skip exactly that one.
let draftingUserReplies = 0;
let draftingBlockedProposals = 0; // v0.15.1: stuck-gate escape hatch
let draftingSeedInFlight = false;

// Dedup set for token accounting (agent_end may replay seen messages).
const countedTokenMessages = new Set<string>();
const countedLoopTokenMessages = new Set<string>();

// Heartbeat self-watchdog state: liveness is the loop's own job.
let lastActivityAt = Date.now();
let lastWedgeAlertAt = 0;
let heartbeatNudges = 0;
let heartbeatTimer: NodeJS.Timeout | null = null;

function noteActivity(): void {
  lastActivityAt = Date.now();
}

function isSupervising(): boolean {
  return isLoopActive() || (!!state.goal && state.goal.status === "active" && state.goal.autoContinue);
}

// =================================================================
// Live TUI (v0.9.0): persistent status segment + above-editor widget.
// "Can't tell if it's on" is a bug, not a nice-to-have.
// =================================================================

let latestAuditProgress: AuditDisplayProgress | null = null;
let uiTicker: NodeJS.Timeout | null = null;

function refreshUI(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  try {
    const theme = ctx.ui.theme as unknown as import("../goal-loop-display.js").DisplayTheme | undefined;
    // Terminal width for truncation budgets: on wide terminals the widget
    // uses the room instead of cutting at fixed ~60-char floors.
    const width = process.stdout.columns || 80;
    ctx.ui.setStatus("pi-glla", buildStatusText(state, latestAuditProgress, Date.now(), theme));
    ctx.ui.setWidget("pi-glla", buildWidgetLines(state, latestAuditProgress, Date.now(), theme, width));
  } catch {
    // stale ctx — next event refreshes
  }
}

function startUITicker(): void {
  if (uiTicker) return;
  uiTicker = setInterval(() => {
    const ctx = freshCtx();
    if (ctx && isSupervising()) refreshUI(ctx);
  }, 1_000);
  uiTicker.unref?.();
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
  // Wedge alert (v0.23.2): session BUSY but silent for the threshold —
  // the classic hung-command case (a test suite that never exits holds
  // the entire goal hostage; field-observed at 5,056s and 6,800s on the
  // same wedged tool call). Independent of the refire path, which only
  // watches idle sessions.
  const wedgeMinutes = loadSettings(ctx.cwd).wedgeAlertMinutes ?? WEDGE_ALERT_DEFAULT_MINUTES;
  if (
    shouldWedgeAlert({
      supervising: isSupervising(),
      sessionBusy: !sessionIdle,
      silentMs: Date.now() - lastActivityAt,
      msSinceLastAlert: Date.now() - lastWedgeAlertAt,
      thresholdMs: wedgeMinutes * 60_000,
    })
  ) {
    lastWedgeAlertAt = Date.now();
    const msg = `Goal appears wedged: no activity for ${Math.round((Date.now() - lastActivityAt) / 60_000)}m while the session is busy — likely a hung command (test/build/dev server without a timeout). Check the session; Esc kills a stuck tool call.`;
    appendLedger(ctx.cwd, "wedge_alert", { silentMs: Date.now() - lastActivityAt });
    ctx.ui.notify(msg, "warning");
    notifyExternal(ctx, msg);
  }
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
    usage: { tokensUsed: 0, tokensLimit: loadSettings(ctx.cwd).tokenLimit ?? DEFAULT_TOKEN_LIMIT },
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
  refreshUI(ctx); // every state transition flows through here → the TUI is always current
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
  // Loop 2: a list-sourced goal COMPLETED → auto-activate the next item.
  // Aborts are user actions (/list next, /goal cancel, list_activate) which
  // pick their own next step — auto-advancing on abort double-activates
  // (v0.2.0 bug: bare /list next silently consumed TWO items, found by the
  // pick-any-item verification in v0.10.0).
  if (goal.policy === "list" && status === "complete") {
    activateNextListItem(ctx);
  }
}

// =================================================================
// Loop 2: /list list
// =================================================================

function listQueue(): NonNullable<State["list"]> {
  return state.list ?? [];
}

function activateNextListItem(ctx: ExtensionContext, n = 1): boolean {
  const queue = listQueue();
  const taken = takeAt(queue, n);
  if (!taken) return false;
  const [next, rest] = taken;
  state = { ...state, list: rest };
  const goal = createGoal(next.objective, ctx, "list");
  if (next.verificationContract) goal.verificationContract = next.verificationContract;
  setGoal(goal, ctx);
  iterationCounter = 0;
  consecutiveErrorIterations = 0;
  ctx.ui.notify(`List item #${n} activated (${rest.length} remaining): ${goal.objective.slice(0, 80)}`, "info");
  scheduleContinuation(ctx, true);
  return true;
}

// =================================================================
// Drafting: /goal with no args → clarify → Confirm dialog → activate
// =================================================================

async function startDrafting(ctx: ExtensionContext, target: "goal" | "list" | "loop", seed?: string): Promise<void> {
  draftingTarget = target;
  const prompts: Record<string, [string, string, string]> = {
    goal: ["goal-loop-draft.md", "Goal drafting", "propose_goal_draft"],
    list: ["goal-loop-draft.md", "Goal drafting (for the list)", "propose_goal_draft"],
    loop: ["goal-loop-forever-draft.md", "Loop drafting", "propose_loop_draft"],
  };
  const [file, label, tool] = prompts[target]!;
  const seededHint =
    target === "list"
      ? `${label}: the objective has no "Done when:" clause — the agent will grill you about it first (nothing activates until you confirm). Add directly instead: include a "Done when:" clause.`
      : target === "loop"
        ? `${label}: a loop target needs a metric and a direction — the agent will help you design them first (nothing activates until you confirm). Skip the interview entirely: /loop start "<target>" measure="<cmd>" direction=min|max [window=5] [max=50] [time=h] [tokens=n] [branch=1].`
        : `${label}: the objective has no "Done when:" clause — the agent will grill you about it first (nothing activates until you confirm). Skip the interview entirely: /goal start <objective>.`;
  ctx.ui.notify(
    seed
      ? seededHint
      : `${label} started. The agent will grill until the contract is concrete, then ${tool} opens a Confirm dialog. No work begins before confirmation.`,
    "info",
  );
  const tmplPath = path.resolve(__dirname, "..", "..", "prompts", file);
  let tmpl: string;
  try {
    tmpl = fs.readFileSync(tmplPath, "utf-8");
    if (target === "list") {
      tmpl = tmpl.replace(
        "[GOAL DRAFTING]",
        "[GOAL DRAFTING — the confirmed goal goes into the /list LIST, it does not activate immediately. If the user wants MANY things queued (a plan, a checklist, 'these 50 tasks'), propose them ALL AT ONCE with the items[] parameter — one Confirm for the whole batch, never 50 separate proposals.]",
      );
    }
  } catch {
    tmpl = `[DRAFTING] Clarify the user's ${target}, then call ${tool}.`;
  }
  // v0.14.0: the LLM grills (its strength — v0.13.0's canned questionnaire
  // accepted non-answers), the plugin enforces the floor: propose_goal_draft
  // is blocked until the user has replied at least once (see message_start).
  if (seed) {
    tmpl = buildSeedGrillMessage(tmpl, seed, tool);
  }
  try {
    extensionApi?.sendUserMessage(tmpl, { deliverAs: ctx.isIdle() ? "followUp" : "steer" });
    draftingUserReplies = 0;
    draftingBlockedProposals = 0;
    draftingSeedInFlight = true; // our injected prompt also arrives as a user message — don't count it
  } catch {
    draftingTarget = null;
  }
}

// =================================================================
// /goal router (v0.8.0): subcommands route to their handlers; everything
// else is an objective (draft if empty, set+start otherwise).
// =================================================================

async function cmdGoal(args: string, ctx: ExtensionContext): Promise<void> {
  const route = routeGoalArgs(args);
  if (route.kind === "sub") {
    if (route.name === "status") return cmdStatus(ctx);
    if (route.name === "pause") return cmdPause(ctx);
    if (route.name === "resume") return cmdResume(ctx);
    if (route.name === "cancel") return cmdCancel(ctx);
    if (route.name === "tweak") return cmdTweak(route.rest, ctx);
    if (route.name === "archive") return cmdGoals(ctx);
    // v0.16.0: /goal start <objective> — explicit skip-draft. Activates
    // immediately, no interview, no "Done when:" heuristic. Symmetric
    // with /loop start. The auditor infers the contract from the objective.
    if (route.name === "start") {
      if (!route.rest) {
        ctx.ui.notify("Usage: /goal start <objective> — activates immediately, skipping the drafting interview. (Without start, an objective needs a 'Done when:' clause or it gets drafted first.)", "warning");
        return;
      }
      return cmdSet(route.rest, ctx, true);
    }
  }
  return cmdSet(route.kind === "set" ? route.text : "", ctx);
}

// =================================================================
// /goal: bypass drafting, start now (the only entry in v0.1.0)
// =================================================================

async function cmdSet(args: string, ctx: ExtensionContext, skipDraft = false): Promise<void> {
  let raw = args.trim();
  // Users naturally quote the objective ("/goal \"do X\""); strip one layer of
  // surrounding matching quotes so they don't leak into the goal text.
  if (raw.length >= 2 && ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))) {
    raw = raw.slice(1, -1).trim();
  }
  if (!raw) {
    await startDrafting(ctx, "goal");
    return;
  }
  if (isLoopActive()) {
    ctx.ui.notify("A /loop is active — /loop stop it before setting a goal.", "warning");
    return;
  }
  // v0.11.0: a contract-less objective gets drafted, not activated raw —
  // the pi-goal-x lesson: arg + Enter is worse than a 5-minute draft.
  // Include an explicit "Done when: …" clause to activate instantly.
  // v0.16.0: /goal start bypasses this by explicit user command.
  if (!skipDraft && goalArgsNeedDrafting(raw)) {
    await startDrafting(ctx, "goal", raw);
    return;
  }
  draftingTarget = null; // explicit objective cancels any drafting session
  const goal = createGoal(raw, ctx);
  setGoal(goal, ctx);
  // Reset counters
  iterationCounter = 0;
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
    `Tokens: ${(g.usage?.tokensUsed ?? 0).toLocaleString()}${(g.usage?.tokensLimit ?? 0) > 0 ? ` / ${(g.usage!.tokensLimit).toLocaleString()}` : " (no cap — /glla tokenlimit=<n> to set)"}`,
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
  // v0.22.7: name WHAT was paused — a list item resumes through /list.
  if (state.goal.policy === "list") {
    const queued = listQueue().length;
    ctx.ui.notify(`List item ${state.goal.id} paused${queued > 0 ? ` (${queued} queued in the list)` : ""}. /list resume to continue.`, "info");
    return;
  }
  ctx.ui.notify(`Goal ${state.goal.id} paused. /goal resume to continue.`, "info");
}

async function cmdResume(ctx: ExtensionContext): Promise<void> {
  if (!state.goal || state.goal.status !== "paused") return;
  // v0.12.0: refresh the token cap from CURRENT settings on resume — goals
  // snapshot the cap at creation, so a goal paused under an old default
  // (e.g. 10M) would re-pause instantly even after the default changed.
  const freshLimit = loadSettings(ctx.cwd).tokenLimit ?? DEFAULT_TOKEN_LIMIT;
  const usage = state.goal.usage
    ? { tokensUsed: state.goal.usage.tokensUsed, tokensLimit: freshLimit }
    : undefined;
  updateGoal({ status: "active", pauseReason: undefined, pauseSuggestedAction: undefined, ...(usage ? { usage } : {}) }, ctx);
  // v0.22.5: say what was resumed — with a non-empty list this also resumes
  // the queue (the active goal IS the list's head item).
  // v0.22.7: name WHAT was resumed — list items resume through /list.
  const queued = listQueue().length;
  const isListItem = state.goal.policy === "list";
  ctx.ui.notify(
    isListItem
      ? `Resumed list item [${state.goal.id}]: ${state.goal.objective.replace(/\s+/g, " ").slice(0, 70)}${queued > 0 ? ` (+${queued} queued in the list)` : ""}`
      : `Resumed goal [${state.goal.id}]: ${state.goal.objective.replace(/\s+/g, " ").slice(0, 70)}${queued > 0 ? ` (+${queued} queued in the list — resuming the list's head)` : ""}`,
    "info",
  );
  scheduleContinuation(ctx, true);
}

async function cmdCancel(ctx: ExtensionContext): Promise<void> {
  if (!state.goal) return;
  archiveCurrentGoal(ctx, "aborted", "user cancelled");
  ctx.abort();
  ctx.ui.notify("Goal aborted.", "info");
}

async function cmdGoals(ctx: ExtensionContext): Promise<void> {
  const dir = archiveDir(ctx.cwd);
  if (!fs.existsSync(dir)) {
    ctx.ui.notify("No archived goals yet.", "info");
    return;
  }
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort().reverse();
  if (files.length === 0) {
    ctx.ui.notify("No archived goals yet.", "info");
    return;
  }
  const lines = files.slice(0, 20).map((f) => {
    let status = "?";
    let stop = "";
    let obj = "";
    try {
      const content = fs.readFileSync(path.join(dir, f), "utf-8");
      status = content.match(/\*\*Status\*\*:\s*(\w+)/)?.[1] ?? "?";
      stop = content.match(/\*\*Stop reason\*\*:\s*(.+)/)?.[1]?.trim() ?? "";
      obj = content.match(/## Objective\s+>\s*(.+)/)?.[1]?.trim() ?? "";
    } catch { /* unreadable file — show name only */ }
    return `${f.replace(/\.md$/, "")} [${status}] ${obj.slice(0, 60)}${stop ? ` — ${stop.slice(0, 40)}` : ""}`;
  });
  ctx.ui.notify(
    `Archived goals (${files.length}${files.length > 20 ? ", showing 20" : ""}):\n` + lines.join("\n"),
    "info",
  );
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
    ctx.ui.notify("Usage: /goal tweak <replacement objective, optional 'Done when: ...' clause>", "info");
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

/**
 * The ONE enqueue path (v0.8.4): bulk import, items[] drafting, and the
 * agent's list_add tool all funnel here. Texts → ListItems (with per-item
 * contract extraction) → appended to the queue → persisted → first item
 * activated when nothing is running. Returns the count enqueued.
 */
function enqueueItems(ctx: ExtensionContext, texts: string[], source: string): number {
  const items = texts.map((text) => {
    const extracted = extractVerificationContract(text);
    return { id: newGoalId(), objective: extracted.objective, verificationContract: extracted.verificationContract || undefined, addedAt: nowIso() };
  });
  state = { ...state, list: [...listQueue(), ...items] };
  persistState(ctx);
  appendLedger(ctx.cwd, "list_imported", { source, count: items.length });
  if (!state.goal || state.goal.status === "complete" || state.goal.status === "aborted") {
    activateNextListItem(ctx);
  }
  return items.length;
}

/** Bulk-enqueue parsed items: one Confirm for the whole batch, never drafts. */
async function bulkAddItems(ctx: ExtensionContext, parsed: string[], sourceName: string): Promise<void> {
  if (parsed.length === 0) {
    ctx.ui.notify("No items found (headings/blank lines don't count).", "warning");
    return;
  }
  const preview = parsed.slice(0, 5).map((t, i) => `  ${i + 1}. ${t.slice(0, 70)}`).join("\n");
  let confirmed = true;
  if (ctx.hasUI) {
    try {
      confirmed = await ctx.ui.confirm(
        "Import into queue?",
        `${parsed.length} items from ${sourceName}:\n${preview}${parsed.length > 5 ? `\n  … and ${parsed.length - 5} more` : ""}`,
      );
    } catch {
      confirmed = false;
    }
  }
  if (!confirmed) {
    ctx.ui.notify("Import cancelled.", "info");
    return;
  }
  const n = enqueueItems(ctx, parsed, sourceName);
  if (state.goal && state.goal.status === "active") {
    ctx.ui.notify(`Imported ${n} items (${listQueue().length} queued).`, "info");
  }
}

/** Bulk-enqueue from a file: read, parse, delegate to bulkAddItems. */
async function bulkAddFromFile(ctx: ExtensionContext, abs: string): Promise<void> {
  let content: string;
  try {
    content = fs.readFileSync(abs, "utf-8");
  } catch {
    ctx.ui.notify(`Cannot read: ${abs}`, "warning");
    return;
  }
  await bulkAddItems(ctx, parseListImport(content), path.basename(abs));
}

async function cmdList(args: string, ctx: ExtensionContext): Promise<void> {
  const parts = args.trim().split(/\s+/);
  const sub = (parts[0] ?? "").toLowerCase();
  const rest = args.trim().slice(sub.length).trim();

  if (sub === "resume") {
    // Resume the list's head. The head activates AS the active goal, so this
    // is the same motion as /goal resume — named for the surface the user is
    // looking at (v0.22.7: "we would just unpause, and that is next").
    if (!state.goal || state.goal.status !== "paused") {
      ctx.ui.notify("No paused list item to resume. /list show to see the queue.", "info");
      return;
    }
    if (state.goal.policy !== "list") {
      ctx.ui.notify("The paused goal didn't come from the list — /goal resume to continue it.", "info");
      return;
    }
    await cmdResume(ctx);
    return;
  }

  if (!sub || sub === "show") {
    const queue = listQueue();
    const lines: string[] = [];
    if (state.goal) {
      lines.push(`Active: [${state.goal.policy}] ${state.goal.objective.slice(0, 80)} (${statusLabel(state.goal.status)})`);
    } else {
      lines.push("Active: (none)");
    }
    if (queue.length === 0) {
      lines.push("List: empty. /list <describe your tasks, or a plan file> — the agent shapes dumps into items, files import directly.");
    } else {
      lines.push(`List (${queue.length}):`);
      const PAGE = 15;
      queue.slice(0, PAGE).forEach((item, i) => lines.push(`  ${i + 1}. ${item.objective.slice(0, 90)}`));
      if (queue.length > PAGE) {
        lines.push(`  … and ${queue.length - PAGE} more. /list remove <n> to prune, /list clear to empty.`);
      }
    }
    ctx.ui.notify(lines.join("\n"), "info");
    return;
  }


  // v0.19.0: `add` and `import` are pure no-op aliases — the verb changes
  // nothing, detection routes everything. `/list plan.md` and
  // `/list add plan.md` both import; `/list fix x, do y` and
  // `/list add fix x, do y` both draft. Rationale: a list item activates
  // RAW when it reaches the head, so the drafting interview is the only
  // quality gate an item ever gets — a verb whose only job was skipping
  // that gate was a leak, not an escape hatch. The direct path is an
  // explicit "Done when:" clause (user already did the contract work).
  if (sub === "add" || sub === "import") {
    if (!rest) {
      await startDrafting(ctx, "list");
      return;
    }
    const aliased = routeListText(ctx.cwd, rest.replace(/^["']|["']$/g, ""));
    if (aliased.kind === "file") {
      await bulkAddFromFile(ctx, aliased.path);
      return;
    }
    if (aliased.kind === "batch") {
      await bulkAddItems(ctx, aliased.items, "pasted text");
      return;
    }
    if (aliased.kind === "direct") {
      addSingleItem(ctx, aliased.text);
      return;
    }
    await startDrafting(ctx, "list", aliased.seed);
    return;
  }

  if (sub === "clear") {
    state = { ...state, list: [] };
    persistState(ctx);
    appendLedger(ctx.cwd, "list_cleared", {});
    ctx.ui.notify("List cleared. Active goal (if any) is untouched — /goal cancel for that.", "info");
    return;
  }

  if (sub === "next") {
    // Skip the current active goal (abort it) and activate a queued item.
    // Bare = the head (FIFO default); /list next <n> = item n (shopping-list
    // semantics: order is the default, not the law).
    const n = rest ? Number.parseInt(rest, 10) : 1;
    if (!Number.isInteger(n) || n < 1) {
      ctx.ui.notify(`Usage: /list next [1-${listQueue().length || 1}]`, "info");
      return;
    }
    if (state.goal && state.goal.status === "active") {
      archiveCurrentGoal(ctx, "aborted", `skipped via /list next ${n > 1 ? n : ""}`.trim());
    }
    if (!activateNextListItem(ctx, n)) {
      ctx.ui.notify(listQueue().length === 0 ? "List is empty — nothing to activate." : `No item #${n} (list has ${listQueue().length}).`, "info");
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

  // v0.18.0: an unknown first word isn't an error — it's a natural-language
  // dump. "/list fix the login bug, add dark mode, write docs" should MAKE
  // a list, not print usage. Detection chain: file → batch → contract →
  // conversational decomposition (drafting). The explicit verb for adding
  // one item verbatim is /list add.
  let raw = args.trim();
  if (raw.length >= 2 && ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))) {
    raw = raw.slice(1, -1).trim();
  }
  const route = routeListText(ctx.cwd, raw);
  if (route.kind === "file") {
    await bulkAddFromFile(ctx, route.path);
    return;
  }
  if (route.kind === "batch") {
    await bulkAddItems(ctx, route.items, "pasted text");
    return;
  }
  if (route.kind === "direct") {
    addSingleItem(ctx, route.text);
    return;
  }
  await startDrafting(ctx, "list", route.seed);
}

/** Append one objective to the list; activate immediately when idle. */
function addSingleItem(ctx: ExtensionContext, raw: string): void {
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
}

/**
 * Config-gated push notification: if settings.notifyCmd is set, shell out
 * with the message as $1. Fire-and-forget — a broken notify command never
 * blocks the loop. /glla notify='<cmd>' to configure.
 */
function notifyExternal(ctx: ExtensionContext, message: string): void {
  try {
    const settings = loadSettings(ctx.cwd);
    const cmd = settings.notifyCmd;
    if (!cmd || !extensionApi) return;
    void extensionApi.exec("bash", ["-c", cmd, "pi-goal-list-loop-audit", message], { cwd: ctx.cwd }).catch(() => {});
  } catch {
    // non-fatal by design
  }
}

// =================================================================
// Loop 3: /loop — metric-driven process loop (never completes)
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
    const result = await extensionApi.exec("bash", ["-c", cmd], { cwd: ctx.cwd, timeout: MEASURE_TIMEOUT_MS });
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

function loopPrompt(loop: LoopState, regressionNote: string, strategyNote: string, boundsNote: string): string {
  // v0.23.0: metricless loops get their own prompt — no metric section,
  // anti-doorknob rules instead of anti-gaming rules.
  const metricless = !loop.measureCmd;
  const tmplPath = path.resolve(__dirname, "..", "..", "prompts", metricless ? "goal-loop-forever-metricless.md" : "goal-loop-forever.md");
  let tmpl: string;
  try {
    tmpl = fs.readFileSync(tmplPath, "utf-8");
  } catch {
    tmpl = metricless
      ? `[LOOP ITERATION ${loop.iteration + 1}] Target: ${loop.target}. Metricless spec loop — make ONE real, inspectable change advancing the target. No cosmetic churn.`
      : `[LOOP ITERATION ${loop.iteration + 1}] Target: ${loop.target}. Measure: ${loop.measureCmd} (${loop.direction}). Make ONE small change to improve the metric.`;
  }
  return tmpl
    .replace(/\$\{ITERATION\}/g, String(loop.iteration + 1))
    .replace(/\$\{TARGET\}/g, loop.target)
    .replace(/\$\{MEASURE_CMD\}/g, loop.measureCmd ?? "none")
    .replace(/\$\{DIRECTION\}/g, loop.direction ?? "none")
    .replace(/\$\{DIRECTION_WORD\}/g, loop.direction === "min" ? "lower is better" : "higher is better")
    .replace(/\$\{LAST_VALUE\}/g, loop.lastValue === null ? "(none yet)" : String(loop.lastValue))
    .replace(/\$\{BEST_VALUE\}/g, loop.bestValue === null ? "(none yet)" : String(loop.bestValue))
    .replace(/\$\{STALL_COUNT\}/g, String(loop.stallCount))
    .replace(/\$\{PLATEAU_WINDOW\}/g, String(loop.plateauWindow))
    .replace(/\$\{REGRESSION_NOTE\}/g, regressionNote)
    .replace(/\$\{STRATEGY_NOTE\}/g, strategyNote)
    .replace(/\$\{BOUNDS_NOTE\}/g, boundsNote);
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
  // Strategy rotation (from pi-loop-mode's one good idea): one stall before
  // the plateau window closes, stop polishing and change approach entirely.
  const strategyNote = loop.stallCount >= loop.plateauWindow - 1 && loop.stallCount > 0
    ? "**You are one stall from a plateau stop. Small tweaks are not working — try a FUNDAMENTALLY different approach: different file, different technique, or revert and rethink the angle of attack.**"
    : "";
  // v0.15.0: arbitrary bounds (never "completion") — surface what's armed.
  // v0.23.0: for metricless loops the bounds are the ONLY stop (no
  // plateau), so the note names that — and an unbounded metricless loop
  // gets the furnace warning.
  const metricless = !loop.measureCmd;
  const bounds: string[] = [];
  if (loop.timeLimitHours !== undefined) bounds.push(`${loop.timeLimitHours}h`);
  if (loop.tokenBudget !== undefined) bounds.push(`${loop.tokenBudget.toLocaleString()} tokens (used ${(loop.tokensUsed ?? 0).toLocaleString()})`);
  let boundsNote = "";
  if (metricless) {
    if (loop.maxIterations > 0) bounds.unshift(`${loop.maxIterations} iterations`);
    boundsNote = bounds.length
      ? `\n- Bounds armed: the loop ends after ${bounds.join(" or ")} — or /loop stop. There is NO plateau stop.`
      : `\n- NO bounds armed — this loop ends only at /loop stop. Spend each iteration like it costs money; it does.`;
  } else if (bounds.length) {
    boundsNote = `\n- Arbitrary bounds: the loop also stops after ${bounds.join(" or ")}`;
  }
  try {
    extensionApi.sendMessage({
      customType: GOAL_EVENT_ENTRY,
      content: loopPrompt(loop, regressionNote, strategyNote, boundsNote),
      display: false,
    }, { triggerTurn: true, deliverAs: "followUp" });
  } catch {
    // stale API — next agent_end reschedules
  }
}

/** agent_end hook for loop 3: measure → judge → continue or stop. */
async function runLoopTick(ctx: ExtensionContext, event?: any): Promise<void> {
  const loop = state.loop!;
  // v0.15.0: token budget is an arbitrary bound; accumulate orchestrator-side.
  if (event?.messages) {
    loop.tokensUsed = (loop.tokensUsed ?? 0) + sumNewAssistantTokens(event.messages as unknown[], countedLoopTokenMessages);
  }
  const metricless = !loop.measureCmd;
  const value = metricless ? null : await runMeasure(ctx, loop.measureCmd!);
  // Hypothesis line (pi-autoresearch's good idea): the agent's stated intent
  // for the turn goes into the ledger, making loop history auditable.
  let hypothesis: string | undefined;
  if (event) {
    const last = [...(event.messages as any[])].reverse().find((m) => m.role === "assistant");
    const text = last && Array.isArray(last.content) ? last.content.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n") : "";
    hypothesis = text.match(/^HYPOTHESIS:\s*(.+)$/m)?.[1]?.trim().slice(0, 200);
  }
  const outcome = metricless ? applyMetriclessTick(loop, nowIso()) : applyMeasurement(loop, value, nowIso());
  persistState(ctx);
  appendLedger(ctx.cwd, "loop_measured", {
    iteration: loop.iteration,
    value,
    best: loop.bestValue,
    stall: loop.stallCount,
    hypothesis,
  });
  // branch=1 mode: commit improvements, hard-reset regressions — always and
  // only on the scratch branch. v0.23.0: a metricless loop has no regression
  // signal, so every iteration stands and is committed.
  if (loop.branchName && outcome.kind === "continue") {
    if (metricless || outcome.improved) {
      await runGit(ctx, ["add", "-A"]);
      const committed = await runGit(ctx, ["commit", "-m", metricless ? `pi-glla-loop: iteration ${loop.iteration}` : `pi-glla-loop: iteration ${loop.iteration} (${loop.direction}=${loop.bestValue})`]);
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

interface LoopConfig {
  target: string;
  /** Empty string = metricless spec loop (v0.23.0). */
  measureCmd: string;
  direction?: "min" | "max";
  plateauWindow: number;
  maxIterations: number;
  branch: boolean;
  force?: boolean;
  timeLimitHours?: number;
  tokenBudget?: number;
}

/** Shared loop-start path: /loop start AND propose_loop_draft (after Confirm). */
async function startLoopFromConfig(ctx: ExtensionContext, cfg: LoopConfig): Promise<boolean> {
  // branch=1 mode: scratch branch ONLY. Refuse on non-git or dirty tree —
  // we never mix uncommitted user work into the loop's branch.
  let branchName: string | undefined;
  let originalBranch: string | undefined;
  if (cfg.branch) {
    const isRepo = await runGit(ctx, ["rev-parse", "--is-inside-work-tree"]);
    if (!isRepo.ok) {
      ctx.ui.notify("branch=1 requires a git repository.", "warning");
      return false;
    }
    const dirty = await runGit(ctx, ["status", "--porcelain"]);
    if (!dirty.ok || dirty.stdout.length > 0) {
      ctx.ui.notify("branch=1 requires a clean working tree — commit or stash your changes first.", "warning");
      return false;
    }
    const current = await runGit(ctx, ["rev-parse", "--abbrev-ref", "HEAD"]);
    originalBranch = current.ok ? current.stdout : undefined;
    branchName = loopBranchName(nowIso(), cfg.target);
    const created = await runGit(ctx, ["checkout", "-b", branchName]);
    if (!created.ok) {
      ctx.ui.notify(`Failed to create scratch branch ${branchName}.`, "warning");
      return false;
    }
  }
  // Baseline measurement before the first agent turn. A measure that
  // produces no number is a footgun: without a baseline the loop burns stall
  // iterations before plateau stops it. Refuse fast (force=1 overrides for
  // measures that only work after the agent builds something first).
  // v0.23.0: metricless loops skip the baseline entirely — there is no
  // measure to run, and no plateau to protect.
  const metricless = !cfg.measureCmd;
  const baseline = metricless ? null : await runMeasure(ctx, cfg.measureCmd);
  if (!metricless && baseline === null && !(cfg as { force?: boolean }).force) {
    ctx.ui.notify(
      `/loop start refused: the measure produced no number.\nCommand: ${cfg.measureCmd}\nFix it so it prints exactly one number, or re-run with force=1 if it only works after the agent builds something first.\n(Non-numeric goal — research, docs, features? Use /goal: the independent auditor verifies semantically. /loop only believes a number.)`,
      "warning",
    );
    return false;
  }
  state = {
    ...state,
    loop: {
      target: cfg.target,
      measureCmd: cfg.measureCmd || undefined,
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
      timeLimitHours: cfg.timeLimitHours,
      tokenBudget: cfg.tokenBudget,
      tokensUsed: 0,
      branchName,
      originalBranch,
    },
  };
  persistState(ctx);
  appendLedger(ctx.cwd, "loop_started", { target: cfg.target, measureCmd: cfg.measureCmd || "none", direction: cfg.direction ?? "none", baseline, branch: branchName, timeLimitHours: cfg.timeLimitHours, tokenBudget: cfg.tokenBudget });
  ctx.ui.notify(
    metricless
      ? `Loop started (metricless spec loop — NO plateau stop): ${cfg.target.slice(0, 60)}\nEnds only at ${cfg.maxIterations > 0 ? `max ${cfg.maxIterations} iterations` : "no iteration cap"}${cfg.timeLimitHours ? ` · ${cfg.timeLimitHours}h` : ""}${cfg.tokenBudget ? ` · ${cfg.tokenBudget.toLocaleString()} tokens` : ""} · /loop stop. Every iteration must make ONE real, inspectable change — cosmetic churn is the doorknob failure.` +
        (branchName ? `\nbranch mode: committing each iteration to ${branchName}` : "")
      : `Loop started: ${cfg.target.slice(0, 60)}\nBaseline: ${baseline ?? "(forced without a number — first turn must produce one)"} · direction ${cfg.direction} · window ${cfg.plateauWindow} · ${cfg.maxIterations > 0 ? `max ${cfg.maxIterations}` : "no iteration cap"}` +
        (branchName ? `\nbranch mode: committing improvements to ${branchName}` : ""),
    "info",
  );
  scheduleLoopTick(ctx);
  return true;
}

async function cmdLoop(args: string, ctx: ExtensionContext): Promise<void> {
  const parts = args.trim().split(/\s+/);
  const sub = (parts[0] ?? "").toLowerCase();
  const rest = args.trim().slice(sub.length).trim();

  if (!sub) {
    // /loop with no args → resume a held loop if one is waiting; otherwise
    // draft the loop config (metric design is the whole game for a
    // long-running loop; never start one blind).
    if (isLoopActive()) {
      ctx.ui.notify("A loop is already active — /loop status to inspect, /loop stop to end it.", "info");
      return;
    }
    const stored = state.loop;
    if (stored && !stored.active && stored.stopReason === HELD_ON_RESTORE) {
      state.loop = { ...stored, active: true, stopReason: undefined };
      persistState(ctx);
      scheduleLoopTick(ctx);
      ctx.ui.notify(
        `Loop resumed: iteration ${stored.iteration}/${stored.maxIterations > 0 ? stored.maxIterations : "∞"} · best ${stored.bestValue ?? "n/a"} — ${stored.target.slice(0, 60)}`,
        "info",
      );
      return;
    }
    await startDrafting(ctx, "loop");
    return;
  }

  if (sub === "status") {
    const loop = state.loop;
    if (!loop) {
      ctx.ui.notify("No loop. /loop to draft one, or /loop start \"<target>\" measure=\"<cmd>\" direction=min|max [window=5] [max=50] [time=<hours>] [tokens=<budget>]", "info");
      return;
    }
    const lines = [
      `Loop: ${loop.active ? "active" : "stopped"} — ${loop.target.slice(0, 80)}`,
      `Metric: ${loop.measureCmd ? `${loop.measureCmd} (${loop.direction})` : "none — metricless spec loop (no plateau)"}`,
      `Iteration ${loop.iteration}/${loop.maxIterations > 0 ? loop.maxIterations : "∞"} · best ${loop.bestValue ?? "n/a"} · last ${loop.lastValue ?? "n/a"} · stall ${loop.stallCount}/${loop.plateauWindow}`,
    ];
    const bounds: string[] = [];
    if (loop.timeLimitHours !== undefined) bounds.push(`time ≤ ${loop.timeLimitHours}h`);
    if (loop.tokenBudget !== undefined) bounds.push(`tokens ${(loop.tokensUsed ?? 0).toLocaleString()}/${loop.tokenBudget.toLocaleString()}`);
    if (bounds.length) lines.push(`Bounds: ${bounds.join(" · ")}`);
    if (loop.refinements?.length) lines.push(`Spec refined ${loop.refinements.length}× (latest: iteration ${loop.refinements[loop.refinements.length - 1]!.iteration})`);
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
      ctx.ui.notify("A goal is active — /goal cancel or /goal pause it before starting a loop.", "warning");
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
      ctx.ui.notify(
        `/loop start: ${err instanceof Error ? err.message : String(err)}\n(Non-numeric goal — research, docs, features? Use /goal: the auditor verifies semantically. /loop only believes a number. Or /loop with no args to draft.)`,
        "warning",
      );
      return;
    }
    await startLoopFromConfig(ctx, cfg);
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

  // Anything else is a natural-language target (v0.22.4): draft it — the
  // metric is the whole game for a loop, and /loop start with full params
  // is the skip-drafting path. Previously this fell through to a usage
  // line, so "/loop make the tests faster" did nothing useful.
  if (isLoopActive()) {
    ctx.ui.notify("A loop is already active — /loop status to inspect, /loop stop to end it.", "info");
    return;
  }
  await startDrafting(ctx, "loop", args.trim());
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
      const { model: auditorModel, error: modelError, via } = resolveAuditorModel(ctx, settings.auditorModel);
      if (modelError) {
        ctx.ui.notify(`Auditor model issue: ${modelError}`, "warning");
      }
      ctx.ui.notify(`Auditor running (isolated session, model: ${via ?? "setting"})…`, "info");
      // Esc during the audit aborts this tool's signal → threaded into the
      // auditor session, which aborts cleanly and returns "Auditor aborted."
      latestAuditProgress = { label: "starting" };
      const result = await runGoalCompletionAuditor({
        ctx,
        goal: state.goal,
        completionSummary: p.completionSummary,
        verificationSummary: p.verificationSummary,
        model: auditorModel,
        thinkingLevel: settings.auditorThinkingLevel ?? getSessionThinkingLevel(),
        signal: signal ?? undefined,
        onProgress: (progress) => {
          latestAuditProgress = {
            currentTool: progress.currentTool,
            label: progress.label,
            elapsedMs: progress.elapsedMs,
          };
          refreshUI(ctx);
        },
      });
      latestAuditProgress = null;
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
          regressionShieldMissing: result.regressionShieldMissing,
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
      }

      // THREE-WAY SPLIT (v0.9.9): infrastructure failure is NOT a verdict.
      // The wild-caught case: 6 silent "disapprovals" that were really a dead
      // auditor model. The agent must be able to tell the difference.
      if (result.error && !result.disapproved) {
        updateGoal({
          status: "active",
          auditHistory: history,
          pauseReason: `auditor infrastructure: ${result.error}`,
          pauseSuggestedAction: "Fix the auditor model (/glla model=provider/id) and call complete_goal again — your work was NOT judged",
        }, ctx);
        scheduleContinuation(ctx, true);
        return {
          content: [{
            type: "text",
            text: `The auditor could not run (infrastructure, NOT a verdict): ${result.error}\nYour completion claim was not evaluated. Fix the auditor model with /glla model=provider/id and call complete_goal again — do not change your deliverable for this.`,
          }],
          details: {},
        };
      }

      // Shield-blocked approval (v0.22.6): the auditor APPROVED but the
      // regression shield found contract items the evidence never
      // referenced. NOT a verdict on the work — the next audit is told
      // exactly what to quote. (The hegemon case: three genuine approvals
      // shield-blocked on vocabulary mismatches read as a "parser bug".)
      if (result.regressionShieldPassed === false && result.regressionShieldMissing && result.regressionShieldMissing.length > 0) {
        const missing = result.regressionShieldMissing;
        updateGoal({
          status: "active",
          auditHistory: history,
          pauseReason: `regression shield: auditor approved, but evidence never referenced ${missing.length} contract item(s)`,
          pauseSuggestedAction: "call complete_goal again — the next auditor run is told exactly which items to quote evidence for",
        }, ctx);
        scheduleContinuation(ctx, true);
        return {
          content: [{
            type: "text",
            text: `The auditor APPROVED, but the orchestrator's regression shield blocked completion: the report's evidence never referenced these contract items:\n${missing.map((i) => `- ${i}`).join("\n")}\n\nThis is NOT a verdict on your work — do not change your deliverable for this. Call complete_goal again; the next auditor run is explicitly told to quote raw evidence for each of these items.`,
          }],
          details: {},
        };
      }

      const noContractHint = state.goal.verificationContract?.trim()
        ? ""
        : "\n\nNote: this goal has no verification contract, so the auditor inferred done-criteria from the objective text. For sharper verdicts, /goal tweak the objective to add a 'Done when: ...' clause.";
      updateGoal({
        status: "active",
        auditHistory: history,
        pauseReason: "auditor disapproved",
        pauseSuggestedAction: "Inspect auditor feedback and fix the actual gap before calling complete_goal again",
      }, ctx);
      scheduleContinuation(ctx, true);
      return {
        content: [{
          type: "text",
          text: `Auditor disapproved. Report (first 800 chars):\n${result.output.slice(0, 800)}${noContractHint}`,
        }],
        details: {},
      };
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
      return { content: [{ type: "text", text: "Goal paused. /goal resume to continue." }], details: {} };
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
    description: "During goal drafting (/goal with no args), propose the clarified goal contract. Opens the user's Confirm dialog — nothing activates until they confirm. BLOCKED until the user has replied to at least one of your interview questions.",
    parameters: Type.Object({
      objective: Type.String({ description: "The clarified, concrete objective (single item) or a summary when items[] is used" }),
      verificationContract: Type.Optional(Type.String({ description: "Checkable done-criteria (commands, file states, test outcomes)" })),
      items: Type.Optional(Type.Array(Type.String(), { description: "LIST drafting only: many objectives at once (e.g. 'queue these 50 things'). Each becomes a list item; per-item 'Done when:' clauses are honored." })),
    }),
    async execute(_id, params, _signal, _onUpdate, execCtx) {
      const p = params as { objective: string; verificationContract?: string; items?: string[] };
      if (draftingTarget !== "goal" && draftingTarget !== "list") {
        return {
          content: [{ type: "text", text: "Not in goal drafting mode. The user starts drafting with /goal or /list add (no args), or activates directly with /goal <objective>." }],
          details: {},
        };
      }
      // v0.14.0: the interview floor — no Confirm until the user replied.
      // v0.14.0: the interview floor — no Confirm until the user replied.
      if (draftingUserReplies === 0) draftingBlockedProposals++;
      const block = draftProposalBlock(draftingUserReplies, draftingBlockedProposals);
      if (block) {
        return { content: [{ type: "text", text: block }], details: {} };
      }
      // Multi-item drafts are LIST-only: a goal is single by definition.
      if (p.items && p.items.length > 0 && draftingTarget !== "list") {
        return {
          content: [{ type: "text", text: "items[] is only valid in /list drafting — a goal is a single objective. Propose one objective, or ask the user to switch to /list." }],
          details: {},
        };
      }
      const liveCtx = (execCtx as ExtensionContext | undefined) ?? ctx;
      // Multi-item list draft: one Confirm for the whole batch.
      if (p.items && p.items.length > 0) {
        const preview = p.items.slice(0, 6).map((t, i) => `  ${i + 1}. ${t.slice(0, 60)}`).join("\n");
        const batchActivates = !state.goal || state.goal.status === "complete" || state.goal.status === "aborted";
        let batchConfirmed = false;
        try {
          batchConfirmed = await liveCtx.ui.confirm(
            "Confirm queue batch",
            `${p.items.length} items:\n${preview}${p.items.length > 6 ? `\n  … and ${p.items.length - 6} more` : ""}${batchActivates ? "\n\n(List is empty — confirming ACTIVATES item 1 immediately as the active goal.)" : ""}`,
          );
        } catch {
          batchConfirmed = false;
        }
        if (!batchConfirmed) {
          return {
            content: [{ type: "text", text: "Batch rejected by the user. Ask what to change, refine the item list, and propose again." }],
            details: {},
          };
        }
        draftingTarget = null;
        const wasIdle = !state.goal || state.goal.status === "complete" || state.goal.status === "aborted";
        const n = enqueueItems(liveCtx, p.items, "drafted batch");
        if (wasIdle) {
          return { content: [{ type: "text", text: `${n} items confirmed; first activated (list was empty). Begin work now.` }], details: {} };
        }
        return { content: [{ type: "text", text: `${n} items confirmed and queued (${listQueue().length} waiting).` }], details: {} };
      }
      const normContract = p.verificationContract?.trim() ? normalizeDraftContract(p.verificationContract) : "";
      const checkCount = normContract ? draftContractItemCount(normContract) : 0;
      const contractBlock = normContract
        ? `\n\nDone when${checkCount > 0 ? ` — ${checkCount} check${checkCount === 1 ? "" : "s"}` : ""}:\n${normContract}`
        : "\n\n(No verification contract — the auditor will infer done-criteria from the objective. Consider adding one.)";
      // v0.22.6: a list draft that will activate immediately must SAY so in
      // the Confirm dialog — "I started a list and ended up with a running
      // goal" was a real surprise. Title + trailing note name the outcome.
      const isListDraft = draftingTarget === "list";
      const willActivate = isListDraft && (!state.goal || state.goal.status === "complete" || state.goal.status === "aborted");
      const activationNote = isListDraft
        ? willActivate
          ? "\n\n(List is empty — confirming ACTIVATES this immediately as the active goal. Reject if you only wanted to queue it.)"
          : "\n\n(Goes into the list, queued behind the active goal.)"
        : "";
      let confirmed = false;
      try {
        confirmed = await liveCtx.ui.confirm(isListDraft ? "Confirm list item" : "Confirm goal", `${p.objective.trim()}${contractBlock}${activationNote}`);
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
      const full = p.objective.trim() + (normContract ? `\nDone when:\n${normContract}` : "");
      // List drafting: the confirmed contract goes into the QUEUE, not active.
      if (confirmedTarget === "list") {
        const extracted = extractVerificationContract(full);
        const item = { id: newGoalId(), objective: extracted.objective, verificationContract: extracted.verificationContract || undefined, addedAt: nowIso() };
        state = { ...state, list: [...listQueue(), item] };
        persistState(liveCtx);
        appendLedger(liveCtx.cwd, "list_added", { id: item.id, objective: item.objective, drafted: true });
        if (!state.goal || state.goal.status === "complete" || state.goal.status === "aborted") {
          activateNextListItem(liveCtx);
          return { content: [{ type: "text", text: "Confirmed and activated (list was empty). Begin work now." }], details: {} };
        }
        return { content: [{ type: "text", text: `Confirmed and queued (${listQueue().length} waiting). It activates when the current goal completes.` }], details: {} };
      }
      const goal = createGoal(full, liveCtx);
      setGoal(goal, liveCtx);
      iterationCounter = 0;
      consecutiveErrorIterations = 0;
      scheduleContinuation(liveCtx, true);
      return {
        content: [{ type: "text", text: `Goal confirmed and activated (id ${goal.id}). Begin work now; call complete_goal only when the objective is genuinely satisfied.` }],
        details: {},
      };
    },
  }));

  pi.registerTool(defineTool({
    name: "propose_loop_draft",
    label: "Propose loop draft",
    description: "During loop drafting (/loop with no args), propose the loop configuration. The orchestrator test-runs the measure command ONCE and shows the user real output + parsed number in a Confirm dialog. A measure producing no number is auto-rejected. Omit measureCmd (or pass \"none\") for a metricless spec loop — no plateau stop; ends only at bounds or /loop stop.",
    parameters: Type.Object({
      target: Type.String({ description: "What to improve, concretely" }),
      measureCmd: Type.Optional(Type.String({ description: 'Shell command that prints ONE number representing progress — or the literal "none" for a metricless spec loop' })),
      direction: Type.Optional(Type.Union([Type.Literal("min"), Type.Literal("max")], { description: "min = lower is better, max = higher is better (omit for a metricless loop)" })),
      window: Type.Optional(Type.Number({ description: "Plateau stop after N non-improving iterations (default 5)" })),
      max: Type.Optional(Type.Number({ description: "Iteration cap (default 50)" })),
      time: Type.Optional(Type.Number({ description: "Arbitrary bound: stop after this many hours" })),
      tokens: Type.Optional(Type.Number({ description: "Arbitrary bound: stop after this many tokens (input+output)" })),
      branch: Type.Optional(Type.Boolean({ description: "branch=true: scratch-branch mode (clean git tree required)" })),
    }),
    async execute(_id, params, _signal, _onUpdate, execCtx) {
      const p = params as { target: string; measureCmd?: string; direction?: "min" | "max"; window?: number; max?: number; time?: number; tokens?: number; branch?: boolean };
      if (draftingTarget !== "loop") {
        return {
          content: [{ type: "text", text: "Not in loop drafting mode. The user starts loop drafting with /loop (no args), or starts directly with /loop start." }],
          details: {},
        };
      }
      // v0.14.0: the interview floor — no Confirm until the user replied.
      if (draftingUserReplies === 0) draftingBlockedProposals++;
      const loopBlock = draftProposalBlock(draftingUserReplies, draftingBlockedProposals);
      if (loopBlock) {
        return { content: [{ type: "text", text: loopBlock }], details: {} };
      }
      if (!p.target?.trim()) {
        return { content: [{ type: "text", text: "target is required." }], details: {} };
      }
      // v0.23.0: measureCmd omitted or "none" → metricless spec loop.
      const metricless = !p.measureCmd?.trim() || p.measureCmd.trim().toLowerCase() === "none";
      if (!metricless && p.direction !== "min" && p.direction !== "max") {
        return { content: [{ type: "text", text: 'direction=min|max is required for a measured loop (omit measureCmd or pass "none" for a metricless spec loop).' }], details: {} };
      }
      const liveCtx = (execCtx as ExtensionContext | undefined) ?? ctx;
      // THE TEST-RUN: orchestrator runs the proposed measure once. The user
      // sees the real number before a single iteration burns tokens.
      // (Metricless loops skip this — there is no measure to test-run.)
      let rawOutput = "";
      let parsed: number | null = null;
      if (!metricless && extensionApi) {
        try {
          const result = await extensionApi.exec("bash", ["-c", p.measureCmd!], { cwd: liveCtx.cwd });
          rawOutput = String((result as any)?.stdout ?? "").trim();
          parsed = parseMetric(rawOutput);
        } catch (err) {
          rawOutput = `(measure command failed: ${err instanceof Error ? err.message : String(err)})`;
        }
      }
      if (!metricless && parsed === null) {
        return {
          content: [{
            type: "text",
            text: `Measure test-run produced NO number — proposal auto-rejected.\nCommand: ${p.measureCmd}\nOutput: ${rawOutput.slice(0, 300) || "(empty)"}\nFix the command so it prints exactly one number, sanity-check it against the repo, and propose again.`,
          }],
          details: {},
        };
      }
      const window = p.window && p.window > 0 ? Math.floor(p.window) : 5;
      // v0.23.0: explicit max=0 = truly unbounded (no iteration cap).
      const max = p.max !== undefined && Number.isFinite(p.max) && p.max >= 0 ? Math.floor(p.max) : 50;
      let confirmed = false;
      try {
        confirmed = await liveCtx.ui.confirm(
          "Confirm loop",
          metricless
            ? `Target: ${p.target.trim()}\n\nMeasure: NONE — metricless spec loop. There is NO plateau stop: the loop ends only at ${max > 0 ? `${max} iterations` : "NO iteration cap"}${typeof p.time === "number" && p.time > 0 ? ` · Time bound: ${p.time}h` : ""}${typeof p.tokens === "number" && p.tokens > 0 ? ` · Token bound: ${p.tokens.toLocaleString()}` : ""} · /loop stop.${p.branch ? "\nbranch mode: scratch branch, every iteration committed (clean tree required)" : ""}\n\nEvery iteration must make ONE real, inspectable change — cosmetic churn is the known failure mode (doorknob-polishing). Start it?`
            : `Target: ${p.target.trim()}\n\nMeasure: ${p.measureCmd}\nTest-run output: ${rawOutput.slice(0, 200)}\nParsed number: ${parsed} (${p.direction === "min" ? "lower is better" : "higher is better"})\n\nPlateau stop: ${window} non-improving iterations · Cap: ${max > 0 ? `${max} iterations` : "none (unbounded)"}${typeof p.time === "number" && p.time > 0 ? ` · Time bound: ${p.time}h` : ""}${typeof p.tokens === "number" && p.tokens > 0 ? ` · Token bound: ${p.tokens.toLocaleString()}` : ""}${p.branch ? "\nbranch mode: scratch branch (clean tree required)" : ""}\n\nThe loop never completes — it runs until one of these bounds, plateau, or /loop stop. Start it?`,
        );
      } catch {
        confirmed = false;
      }
      if (!confirmed) {
        return {
          content: [{ type: "text", text: "Loop draft rejected by the user. Ask what to change — target, metric, direction, or window/max — and propose again." }],
          details: {},
        };
      }
      draftingTarget = null;
      const started = await startLoopFromConfig(liveCtx, {
        target: p.target.trim(),
        measureCmd: metricless ? "" : p.measureCmd!.trim(),
        direction: metricless ? undefined : p.direction,
        plateauWindow: window,
        maxIterations: max,
        timeLimitHours: typeof p.time === "number" && Number.isFinite(p.time) && p.time > 0 ? p.time : undefined,
        tokenBudget: typeof p.tokens === "number" && Number.isFinite(p.tokens) && p.tokens > 0 ? Math.floor(p.tokens) : undefined,
        branch: p.branch === true,
      });
      if (!started) {
        return { content: [{ type: "text", text: "Loop could not start (see the warning above — likely a git/dirty-tree issue with branch mode)." }], details: {} };
      }
      return {
        content: [{ type: "text", text: metricless ? "Loop confirmed and started (metricless — no plateau). Make ONE real, inspectable change per turn." : `Loop confirmed and started. Baseline ${parsed}. Make ONE small change per turn to move the metric ${p.direction === "min" ? "down" : "up"}.` }],
        details: {},
      };
    },
  }));

  pi.registerTool(defineTool({
    name: "propose_loop_refine",
    label: "Propose loop spec refinement",
    description: "While a loop is ACTIVE, propose refining the loop's spec — sharpen the target and/or change the measure command — when the current spec no longer captures 'better'. The user confirms; on a measure change the orchestrator test-runs the new command and re-baselines. Never edit the measure command or its inputs directly — that is gaming the metric.",
    parameters: Type.Object({
      target: Type.Optional(Type.String({ description: "The sharpened target text (omit to keep the current target)" })),
      measureCmd: Type.Optional(Type.String({ description: "The new measure command printing ONE number (omit to keep the current metric)" })),
      rationale: Type.String({ description: "Why the current spec no longer captures 'better' — shown to the user in the Confirm dialog" }),
    }),
    async execute(_id, params, _signal, _onUpdate, execCtx) {
      const p = params as { target?: string; measureCmd?: string; rationale: string };
      const liveCtx = (execCtx as ExtensionContext | undefined) ?? ctx;
      const loop = state.loop;
      if (!loop?.active) {
        return { content: [{ type: "text", text: "No active loop to refine. propose_loop_refine is only valid while a loop is running." }], details: {} };
      }
      const newTarget = p.target?.trim() || loop.target;
      const newMeasure = p.measureCmd?.trim() || loop.measureCmd || "";
      // v0.23.0: a metricless loop can't be refined into a measured one
      // (no direction, no baseline semantics) — stop and restart instead.
      if (!loop.measureCmd && p.measureCmd?.trim()) {
        return { content: [{ type: "text", text: "This loop is metricless — refining it into a measured loop isn't supported. /loop stop, then /loop start with a metric." }], details: {} };
      }
      if (newTarget === loop.target && newMeasure === loop.measureCmd) {
        return { content: [{ type: "text", text: "Refinement proposed no changes — provide a new target, a new measureCmd, or both." }], details: {} };
      }
      // Measure change → orchestrator test-runs the new command first.
      let newBaseline: number | null = null;
      let testOutput = "";
      if (newMeasure !== loop.measureCmd) {
        if (!extensionApi) return { content: [{ type: "text", text: "No extension API available." }], details: {} };
        try {
          const result = await extensionApi.exec("bash", ["-c", newMeasure], { cwd: liveCtx.cwd });
          testOutput = String((result as any)?.stdout ?? "");
        } catch (e) {
          return { content: [{ type: "text", text: `New measure command failed to run: ${String(e).slice(0, 200)}` }], details: {} };
        }
        newBaseline = parseMetric(testOutput);
        if (newBaseline === null) {
          return {
            content: [{ type: "text", text: `New measure produced NO number — refinement auto-rejected.\nCommand: ${newMeasure}\nOutput: ${testOutput.slice(0, 300) || "(empty)"}\nFix it and propose again.` }],
            details: {},
          };
        }
      }
      let confirmed = false;
      try {
        confirmed = await liveCtx.ui.confirm(
          "Confirm loop spec refinement",
          `Rationale: ${p.rationale}\n\nTarget:\n  old: ${loop.target.slice(0, 120)}\n  new: ${newTarget.slice(0, 120)}\n\nMeasure:\n  old: ${loop.measureCmd}\n  new: ${newMeasure}${newMeasure !== loop.measureCmd ? `\n  test-run: ${testOutput.slice(0, 120)} → ${newBaseline}` : ""}\n\nThe loop keeps running against the refined spec (iteration ${loop.iteration} so far). Apply?`,
        );
      } catch {
        confirmed = false;
      }
      if (!confirmed) {
        return { content: [{ type: "text", text: "Refinement rejected by the user. The loop continues against the current spec — keep improving the metric as defined." }], details: {} };
      }
      applyRefinement(loop, {
        at: nowIso(),
        iteration: loop.iteration,
        oldTarget: loop.target,
        newTarget,
        oldMeasureCmd: loop.measureCmd ?? "",
        newMeasureCmd: newMeasure,
      }, newBaseline);
      persistState(liveCtx);
      appendLedger(liveCtx.cwd, "loop_refined", { iteration: loop.iteration, newTarget, newMeasureCmd: newMeasure, newBaseline });
      liveCtx.ui.notify(`Loop spec refined at iteration ${loop.iteration}.${newBaseline !== null ? ` New baseline: ${newBaseline}.` : ""}`, "info");
      return { content: [{ type: "text", text: "Refinement confirmed and applied. Continue improving against the NEW spec — one small change per turn." }], details: {} };
    },
  }));

  pi.registerTool(defineTool({
    name: "list_add",
    label: "Add to queue",
    description: "Add one or many objectives to the /list list (loop 2). Use when the user asks to queue work — 'add these to my list', 'queue these 10 things', 'put this on the backlog'. Each item becomes an audited goal; per-item 'Done when:' clauses are honored. The first queued item activates automatically when nothing is running. The list is UNBOUNDED — hundreds of small items are fine; propose them all.",
    parameters: Type.Object({
      items: Type.Array(Type.String(), { description: "Objectives to enqueue — no count limit; large plans belong in ONE call." }),
    }),
    async execute(_id, params, _signal, _onUpdate, execCtx) {
      const p = params as { items: string[] };
      if (listMutationBlocked(draftingTarget)) {
        return { content: [{ type: "text", text: LIST_DRAFTING_BLOCK_MESSAGE }], details: {} };
      }
      if (!Array.isArray(p.items) || p.items.length === 0) {
        return { content: [{ type: "text", text: "No items given." }], details: {} };
      }
      const clean = p.items.map((t) => t.trim()).filter((t) => t.length > 0);
      const liveCtx = (execCtx as ExtensionContext | undefined) ?? ctx;
      const wasIdle = !state.goal || state.goal.status === "complete" || state.goal.status === "aborted";
      const n = enqueueItems(liveCtx, clean, "agent list_add");
      return {
        content: [{
          type: "text",
          text: wasIdle
            ? `${n} item(s) queued; the first is now active. Work it normally and call complete_goal when done — the next item activates automatically.`
            : `${n} item(s) queued (${listQueue().length} waiting behind the active goal).`,
        }],
        details: {},
      };
    },
  }));

  pi.registerTool(defineTool({
    name: "list_activate",
    label: "Activate list item",
    description: "Activate a specific item from the /list queue by position (1-based). Order is the default, not the law: use this when a different item should be worked next (e.g. you want to research item 5 while item 1 waits). Aborts the currently active goal if one is running.",
    parameters: Type.Object({
      n: Type.Number({ description: "1-based position in the queue (1 = head)" }),
    }),
    async execute(_id, params, _signal, _onUpdate, execCtx) {
      const p = params as { n: number };
      if (listMutationBlocked(draftingTarget)) {
        return { content: [{ type: "text", text: LIST_DRAFTING_BLOCK_MESSAGE }], details: {} };
      }
      const n = Math.floor(p.n);
      if (!Number.isInteger(n) || n < 1) {
        return { content: [{ type: "text", text: "n must be a positive integer (1-based position)." }], details: {} };
      }
      const liveCtx = (execCtx as ExtensionContext | undefined) ?? ctx;
      if (state.goal && state.goal.status === "active") {
        archiveCurrentGoal(liveCtx, "aborted", "skipped via list_activate");
      }
      if (!activateNextListItem(liveCtx, n)) {
        return { content: [{ type: "text", text: listQueue().length === 0 ? "List is empty." : `No item #${n} (list has ${listQueue().length} items).` }], details: {} };
      }
      return { content: [{ type: "text", text: `Item #${n} activated. Work it normally; call complete_goal when done.` }], details: {} };
    },
  }));

  pi.registerTool(defineTool({
    name: "list_status",
    label: "List status",
    description: "Show the active goal and the /list list (loop 2) as text: what's running, what's waiting.",
    parameters: Type.Object({}),
    async execute() {
      const lines: string[] = [];
      if (state.goal) {
        lines.push(`Active [${state.goal.policy}] (${statusLabel(state.goal.status)}): ${state.goal.objective}`);
      } else {
        lines.push("Active: (none)");
      }
      const queue = listQueue();
      if (queue.length === 0) {
        lines.push("List: empty.");
      } else {
        lines.push(`List (${queue.length}):`);
        queue.slice(0, 20).forEach((item, i) => lines.push(`${i + 1}. ${item.objective}`));
        if (queue.length > 20) lines.push(`… and ${queue.length - 20} more`);
      }
      if (state.loop) {
        lines.push(`Loop: ${state.loop.active ? "active" : "stopped"} — ${state.loop.target} (best ${state.loop.bestValue ?? "n/a"}, iteration ${state.loop.iteration})`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }], details: {} };
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
  /** Per-goal token budget; crossing it pauses the goal. Off by default
   * (opt-in guard, v0.12.0): unset/0 = no budget. */
  tokenLimit?: number;
  /** v0.23.2: minutes of busy-but-silent before the wedge alert fires
   * (hung-command detector). Unset = 45; 0 = off. */
  wedgeAlertMinutes?: number;
  /** on → restored goals/loops/lists auto-resume even in fresh sessions
   * (unattended rigs). Default off: restore holds until /goal resume. */
  autoResume?: boolean;
}

const DEFAULT_SETTINGS: Settings = {
  // Unset = follow the pi session thinking level (user selects thinking in
  // pi, auditor follows), floor "high" — the auditor is the verification
  // gate, depth is worth more there than speed. /glla thinking= overrides.
  auditorThinkingLevel: undefined,
};

// Two-tier config (v0.7.0): GLOBAL is the normal home — you set things once
// and rarely open this again. PROJECT is the rare local override.
// Resolution: project > global > defaults (per key).
function globalSettingsPath(): string {
  return path.join(os.homedir(), ".pi", "agent", "pi-goal-list-loop-audit.settings.json");
}

function projectSettingsPath(cwd: string): string {
  return path.join(piGlaDir(cwd), "settings.json");
}

function readSettingsFile(file: string): Partial<Settings> {
  try {
    if (!fs.existsSync(file)) return {};
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
    return typeof parsed === "object" && parsed !== null ? parsed as Partial<Settings> : {};
  } catch {
    return {};
  }
}

function loadSettings(cwd: string): Settings {
  return mergeSettings(
    DEFAULT_SETTINGS as unknown as Record<string, unknown>,
    readSettingsFile(globalSettingsPath()) as Record<string, unknown>,
    readSettingsFile(projectSettingsPath(cwd)) as Record<string, unknown>,
  ) as unknown as Settings;
}

/** Where each effective setting comes from (for the /glla display). */
function settingsProvenance(cwd: string): Record<keyof Settings, { value: unknown; source: "project" | "global" | "default" }> {
  const proj = readSettingsFile(projectSettingsPath(cwd));
  const glob = readSettingsFile(globalSettingsPath());
  const effective = loadSettings(cwd);
  const out: Record<string, { value: unknown; source: "project" | "global" | "default" }> = {};
  const keys: Array<keyof Settings> = ["auditorModel", "auditorThinkingLevel", "notifyCmd", "tokenLimit", "wedgeAlertMinutes", "autoResume"];
  for (const k of keys) {
    if ((proj as Record<string, unknown>)[k] !== undefined) out[k] = { value: (proj as any)[k], source: "project" };
    else if ((glob as Record<string, unknown>)[k] !== undefined) out[k] = { value: (glob as any)[k], source: "global" };
    else out[k] = { value: (effective as any)[k], source: "default" };
  }
  return out as Record<keyof Settings, { value: unknown; source: "project" | "global" | "default" }>;
}

function saveSettings(scope: "global" | "project", cwd: string, patch: Partial<Settings>): void {
  const file = scope === "global" ? globalSettingsPath() : projectSettingsPath(cwd);
  const current = readSettingsFile(file);
  const next: Record<string, unknown> = { ...current };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete next[k]; // key=unset removes the key
    else next[k] = v;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next, null, 2));
}

/**
 * Session thinking level with a "high" floor (v0.8.5): the auditor follows
 * the thinking level the user selected in pi; if none is set, audits run at
 * "high" — the auditor is the verification gate, depth beats speed there.
 */
function getSessionThinkingLevel(): "off" | "minimal" | "low" | "medium" | "high" | "xhigh" {
  try {
    const level = extensionApi?.getThinkingLevel?.();
    if (level && ["off", "minimal", "low", "medium", "high", "xhigh"].includes(level)) {
      return level as "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
    }
  } catch {
    // fall through to the floor
  }
  return "high";
}

/**
 * Resolve the auditor model (v0.6.2). The principle: **the user selects the
 * model in pi; the auditor uses it.** The plugin never picks a model itself.
 *
 * Chain:
 *   1. Explicit `/glla model=provider/id` override (rare).
 *   2. The pi session model (ctx.model) — whatever the user selected.
 *
 * If the session model's provider is extension-registered, the auditor's
 * extension-less session cannot auth it; that failure is surfaced with a
 * clear explanation (switch pi's model to a built-in provider, or set the
 * override) — we do NOT silently substitute a different model.
 */
function resolveAuditorModel(ctx: ExtensionContext, ref?: string): { model: any; error?: string; via?: string } {
  if (ref && ref.trim()) {
    const trimmed = ref.trim();
    const slash = trimmed.indexOf("/");
    if (slash > 0) {
      const provider = trimmed.slice(0, slash);
      const id = trimmed.slice(slash + 1);
      const model = ctx.modelRegistry.find(provider, id);
      return model ? { model, via: "setting" } : { model: undefined, error: `model not found: ${trimmed}` };
    }
    const matches = ctx.modelRegistry.getAvailable().filter((m: any) => m.id === trimmed || m.name === trimmed);
    return matches[0] ? { model: matches[0], via: "setting" } : { model: undefined, error: `no available model matching: ${trimmed}` };
  }
  const sessionModel = ctx.model as any;
  if (sessionModel) return { model: sessionModel, via: "session" };
  return { model: undefined, error: "no session model and no auditorModel configured — set one with /glla model=provider/id" };
}

// (v0.9.12) The auto-fallback apparatus was REMOVED: no tier ranking, no
// candidate chains, no dead-model caches. The plugin never picks a model —
// you select it in pi (session model) or in /glla (explicit override). When
// neither works, the failure surfaces plainly (see the three-way split in
// the complete_goal handler) with the exact fix; nothing is substituted
// silently.

/**
 * The /glla interactive settings UI (v0.8.0): a menu loop over pi's dialog
 * primitives. Pick a setting → edit it → saved to GLOBAL → back to the menu.
 * Done/Esc exits. Rarely opened by design; scriptable /glla key=value remains
 * for tmux/headless.
 */
async function openSettingsUI(ctx: ExtensionContext): Promise<void> {
  for (;;) {
    const prov = settingsProvenance(ctx.cwd);
    const show = (k: keyof Settings, fallback: string) => {
      const p = prov[k];
      const v = p.value === undefined ? fallback : String(p.value);
      return `${v}  [${p.source}]`;
    };
    let choice: string | undefined;
    try {
      choice = await ctx.ui.select(
        `pi-goal-list-loop-audit settings — global: ${globalSettingsPath()}`,
        [
          `Auditor model override — ${show("auditorModel", "(pi session model)")}`,
          `Auditor thinking — ${show("auditorThinkingLevel", "(session, floor high)")}`,
          `Notify command — ${show("notifyCmd", "(off)")}`,
          `Token limit per goal — ${show("tokenLimit", "(off)")}`,
          `Wedge alert minutes — ${show("wedgeAlertMinutes", `(${WEDGE_ALERT_DEFAULT_MINUTES}m default)`)}`,
          "Done",
        ],
      );
    } catch {
      return;
    }
    if (!choice || choice === "Done") return;
    try {
      if (choice.startsWith("Auditor model")) {
        const v = await ctx.ui.input("Auditor model override", "provider/model-id — empty keeps the pi session model");
        if (v !== undefined) saveSettings("global", ctx.cwd, { auditorModel: v.trim() || undefined });
      } else if (choice.startsWith("Auditor thinking")) {
        const v = await ctx.ui.select("Auditor thinking level", ["off", "minimal", "low", "medium", "high", "xhigh"]);
        if (v) saveSettings("global", ctx.cwd, { auditorThinkingLevel: v as Settings["auditorThinkingLevel"] });
      } else if (choice.startsWith("Notify command")) {
        const v = await ctx.ui.input("Notify command — the event message is passed as $1", "e.g. a desktop-notification or push command; empty = off");
        if (v !== undefined) saveSettings("global", ctx.cwd, { notifyCmd: v.trim() || undefined });
      } else if (choice.startsWith("Token limit")) {
        const v = await ctx.ui.input("Per-goal token budget", "non-negative integer; 0 or empty = off (no cap)");
        if (v !== undefined) {
          const n = Number.parseInt(v.trim(), 10);
          if (Number.isFinite(n) && n >= 0) saveSettings("global", ctx.cwd, { tokenLimit: n });
          else if (!v.trim()) saveSettings("global", ctx.cwd, { tokenLimit: undefined });
          else ctx.ui.notify(`Not a non-negative integer: ${v}`, "warning");
        }
      } else if (choice.startsWith("Wedge alert")) {
        const v = await ctx.ui.input("Wedge alert threshold (minutes)", "non-negative integer; 0 = off, empty = default 45");
        if (v !== undefined) {
          const n = Number.parseInt(v.trim(), 10);
          if (Number.isFinite(n) && n >= 0) saveSettings("global", ctx.cwd, { wedgeAlertMinutes: n });
          else if (!v.trim()) saveSettings("global", ctx.cwd, { wedgeAlertMinutes: undefined });
          else ctx.ui.notify(`Not a non-negative integer: ${v}`, "warning");
        }
      }
    } catch {
      return;
    }
  }
}

async function cmdSettings(args: string, ctx: ExtensionContext): Promise<void> {
  // The plugin's ONE config surface — global by default, rarely opened.
  //   /glla                      show effective values + where each comes from
  //   /glla model=provider/id    write to GLOBAL config
  //   /glla thinking=high        write to GLOBAL config
  //   /glla notify='cmd $1'      write to GLOBAL config
  //   /glla tokenlimit=2000000   write to GLOBAL config
  //   /glla wedgealert=30         hung-command alert minutes (0=off, unset=30)
  //   /glla project model=...    write to PROJECT override (rare)
  //   /glla model=unset          remove key (from global; project model=unset for project)
  const trimmed = args.trim();
  if (!trimmed) {
    if (ctx.hasUI) {
      await openSettingsUI(ctx);
      return;
    }
    // Headless fallback: text display with provenance.
    const prov = settingsProvenance(ctx.cwd);
    const fmt = (k: keyof Settings, label: string) => {
      const p = prov[k];
      const v = p.value === undefined ? "(unset)" : String(p.value);
      return `${label}: ${v}  [${p.source}]`;
    };
    ctx.ui.notify(
      [
        fmt("auditorModel", "auditorModel"),
        fmt("auditorThinkingLevel", "thinking"),
        fmt("notifyCmd", "notify"),
        fmt("tokenLimit", "tokenLimit"),
        fmt("autoResume", "autoResume"),
        `\nglobal:  ${globalSettingsPath()}`,
        `project: ${projectSettingsPath(ctx.cwd)}`,
        `Set with: /glla key=value (global) · /glla project key=value (project override)`,
      ].join("\n"),
      "info",
    );
    return;
  }
  // Optional scope prefix: "project" writes the project override; default is global.
  let scope: "global" | "project" = "global";
  let rest = trimmed;
  if (/^project\s+/i.test(rest)) {
    scope = "project";
    rest = rest.replace(/^project\s+/i, "");
  }
  const patch: Partial<Settings> = {};
  let changed = false;
  // Quote-aware key=value parsing: notify='echo $1 >> /tmp/log' must survive
  // with its spaces intact (naive whitespace splitting mangled it to "'echo").
  const kvRe = /(\w+)=(?:"([^"]*)"|'([^']*)'|(\S+))/g;
  let m: RegExpExecArray | null;
  while ((m = kvRe.exec(rest)) !== null) {
    const key = m[1]!.toLowerCase();
    const value = m[2] ?? m[3] ?? m[4] ?? "";
    if (key === "model" || key === "auditormodel") {
      patch.auditorModel = value === "unset" ? undefined : value;
      changed = true;
    } else if (key === "notify" || key === "notifycmd") {
      patch.notifyCmd = value === "unset" ? undefined : value;
      changed = true;
    } else if (key === "tokenlimit") {
      const n = Number.parseInt(value, 10);
      if (Number.isFinite(n) && n > 0) {
        patch.tokenLimit = n;
        changed = true;
      } else {
        ctx.ui.notify(`tokenlimit must be a positive integer, got: ${value}`, "warning");
      }
    } else if (key === "wedgealert") {
      if (value === "unset") {
        patch.wedgeAlertMinutes = undefined;
        changed = true;
      } else {
        const n = Number.parseInt(value, 10);
        if (Number.isFinite(n) && n >= 0) {
          patch.wedgeAlertMinutes = n; // 0 = off; unset = default 45
          changed = true;
        } else {
          ctx.ui.notify(`wedgealert must be a non-negative integer (minutes, 0 = off), got: ${value}`, "warning");
        }
      }
    } else if (key === "autoresume") {
      if (["on", "true", "1", "yes"].includes(value)) {
        patch.autoResume = true;
        changed = true;
      } else if (["off", "false", "0", "no", "unset"].includes(value)) {
        patch.autoResume = undefined;
        changed = true;
      } else {
        ctx.ui.notify(`autoresume must be on or off, got: ${value}`, "warning");
      }
    } else if (key === "thinking" || key === "auditorthinkinglevel") {
      if (["off", "minimal", "low", "medium", "high", "xhigh"].includes(value)) {
        patch.auditorThinkingLevel = value as Settings["auditorThinkingLevel"];
        changed = true;
      } else {
        ctx.ui.notify(`Unknown thinking level: ${value}`, "warning");
      }
    }
  }
  if (!changed) {
    ctx.ui.notify("Nothing changed. Use key=value (model, thinking, notify, tokenlimit, autoresume), optionally prefixed with 'project'.", "info");
    return;
  }
  saveSettings(scope, ctx.cwd, patch);
  const effective = loadSettings(ctx.cwd);
  ctx.ui.notify(
    `Saved to ${scope} config. Effective now: model=${effective.auditorModel ?? "(session model)"} thinking=${effective.auditorThinkingLevel ?? "(session)"} notify=${effective.notifyCmd ?? "(off)"} tokenLimit=${effective.tokenLimit ?? 0}${(effective.tokenLimit ?? 0) > 0 ? "" : " (off)"} autoResume=${effective.autoResume === true ? "on" : "off"}\n` +
    `Note: the auditor runs without extensions — it must be a built-in provider, not an extension-registered one.`,
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

const OUR_COMMANDS = ["goal", "glla", "list", "loop"];
let collisionWarned = false;

// Providers known to pi core. The auditor inherits the already-resolved
// Model object from this session (in-process createAgentSession), so a
// provider defined in ~/.pi/agent/models.json with auth.json credentials
// works even though it is not "built-in". Unknown providers get a soft
// one-time conditional notice: if audits error with auth failures, an
// explicit /glla model= override is the fix. (v0.22.0: reworded from the
// stale "extension-registered → auditor fails auth" premise.)
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
      `pi-goal-list-loop-audit: session provider "${provider}" is not a known built-in. The auditor inherits the resolved model in-process, so this usually works — but if audits error with auth/provider failures, set an explicit override once: /glla model=provider/id`,
      "info",
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
        `pi-goal-list-loop-audit: command collision on ${dupes.join(", ")}. Another extension registered the same name; ours may be reachable as /${first.slice(1)}:2. Consider disabling the other plugin.`,
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
  startUITicker();
  // Four top-level commands, that's all (v0.8.0 consolidation):
  //   /goal  — set/draft + status|pause|resume|cancel|tweak|archive subcommands
  //   /list — the list (add|show|next|remove|clear)
  //   /loop  — the metric loop (draft|start|status|stop)
  //   /glla   — the settings UI (+ scriptable key=value)
  // v0.22.5: subcommand autocomplete for the /-menu.
  const completions = (items: Array<[string, string]>) => (prefix: string) =>
    items
      .filter(([value]) => value.startsWith(prefix))
      .map(([value, description]) => ({ value, label: value, description }));

  pi.registerCommand("goal", {
    description: "Set/draft a goal, or /goal status|pause|resume|cancel|tweak <text>|archive|start <objective>. Objectives without a 'Done when:' clause are grilled into a contract first; include the clause or use /goal start to skip the interview and activate instantly.",
    getArgumentCompletions: completions([
      ["start", "skip drafting — /goal start <objective> activates immediately"],
      ["status", "show the active goal and its task list"],
      ["pause", "pause the active goal"],
      ["resume", "resume a paused goal (and the list, when items are queued)"],
      ["cancel", "abort the active goal"],
      ["tweak", "change the objective: /goal tweak <text>"],
      ["archive", "list archived goals"],
    ]),
    handler: (args: string, ctx: ExtensionContext) => { rememberCtx(ctx); return cmdGoal(args, ctx); },
  });
  const settingsHandler = (args: string, ctx: ExtensionContext) => { rememberCtx(ctx); return cmdSettings(args, ctx); };
  pi.registerCommand("glla", {
    description: "Open the settings UI for goals, loops, lists, and the auditor. Scriptable form: /glla key=value · /glla project key=value",
    getArgumentCompletions: completions([
      ["model=", "auditor model override: /glla model=provider/id"],
      ["thinking=", "auditor thinking level: /glla thinking=high"],
      ["notify=", "desktop push command: /glla notify='notify-send pi \"$1\"'"],
      ["tokenlimit=", "per-goal token budget (0 = off): /glla tokenlimit=2000000"],
      ["autoresume=", "on: auto-resume held goals/loops in fresh sessions"],
      ["project", "write a project override: /glla project key=value"],
    ]),
    handler: settingsHandler,
  });
  pi.registerCommand("list", {
    description: "Loop 2: the list of audited goals — order is the default, not the law. /list <describe tasks or name a plan file> (dumps get shaped into items, files import, 'Done when:' adds directly) | /list show | /list resume | /list next [n] | /list remove <n> | /list clear",
    getArgumentCompletions: completions([
      ["show", "display the queued items"],
      ["resume", "resume the paused list item (the list's head)"],
      ["next", "activate the next item (or /list next <n> for position n)"],
      ["remove", "remove an item: /list remove <n>"],
      ["clear", "empty the list"],
    ]),
    handler: (args: string, ctx: ExtensionContext) => { rememberCtx(ctx); return cmdList(args, ctx); },
  });
  pi.registerCommand("loop", {
    description: "Loop 3: metric-driven process — it never completes. /loop <target> drafts the metric with you · /loop start \"<target>\" measure=\"<cmd>\" direction=min|max [window=5] [max=50] [time=<hours>] [tokens=<budget>] [branch=1] skips drafting · measure=none = metricless spec loop (no plateau; max=0 = unbounded) · /loop status · /loop stop. 'Improve until X' is a /goal, not a loop.",
    getArgumentCompletions: completions([
      ["start", "skip drafting: /loop start \"<target>\" measure=\"<cmd>\" direction=min|max [window=5] [max=50]"],
      ["status", "show metric, iteration, best/last values, stall count"],
      ["stop", "end the loop (keeps the best state)"],
    ]),
    handler: (args: string, ctx: ExtensionContext) => { rememberCtx(ctx); return cmdLoop(args, ctx); },
  });

  // Tool registration is lazy: done on the first session event, when a
  // context exists. Tools show even without an active goal (and return
  // "no active goal" if called).
  let registeredCtx: ExtensionContext | null = null;

  pi.on("message_start", async (event: any, _ctx: ExtensionContext) => {
    // v0.14.0 drafting floor: count real user replies while drafting. Our
    // own injected draft prompt arrives as a user message — skip that one.
    if (draftingTarget === null) return;
    if (event?.message?.role !== "user") return;
    if (draftingSeedInFlight) {
      draftingSeedInFlight = false;
      return;
    }
    draftingUserReplies++;
  });

  // v0.15.1: ask_user_question answers arrive as tool results, not chat
  // messages — count answered (non-cancelled) questionnaires as replies too.
  pi.on("tool_result", async (event: any) => {
    if (draftingTarget === null) return;
    if (askUserQuestionAnswered(String(event?.toolName ?? ""), event?.details)) {
      draftingUserReplies++;
    }
  });

  pi.on("session_start", async (event: any, ctx: ExtensionContext) => {
    rememberCtx(ctx);
    state = readState(ctx.cwd);
    if (!registeredCtx) {
      registerAgentTools(pi, ctx);
      registeredCtx = ctx;
    }
    warnOnCommandCollision(ctx);
    warnIfAuditorProviderRisky(ctx);
    // Restore gate (v0.21.0): a fresh session ("startup"/"new", or a pi too
    // old to report a reason) has no conversation context for the restored
    // work — HOLD instead of auto-firing, so opening pi in a folder never
    // starts working before you can even load your session. Sessions with
    // history ("resume"/"reload"/"fork") auto-resume; /glla autoresume=on
    // opts a project into auto-resume everywhere (unattended rigs).
    const autoResume = shouldAutoResumeOnSessionStart(event?.reason, loadSettings(ctx.cwd).autoResume);
    if (isLoopActive()) {
      const l = state.loop!;
      if (autoResume) {
        ctx.ui.notify(
          `Resuming loop (iteration ${l.iteration}/${l.maxIterations > 0 ? l.maxIterations : "∞"}, best ${l.bestValue ?? "n/a"}, stall ${l.stallCount}/${l.plateauWindow}): ${l.target.slice(0, 60)}`,
          "info",
        );
        scheduleLoopTick(ctx);
      } else {
        state.loop = { ...l, active: false, stopReason: HELD_ON_RESTORE };
        persistState(ctx);
        ctx.ui.notify(
          `Loop held on restore (fresh session, no work started): ${l.target.slice(0, 60)} — /loop to resume, /glla autoresume=on to auto-resume in this project.`,
          "info",
        );
      }
    } else if (state.goal && state.goal.status === "active" && state.goal.autoContinue) {
      if (autoResume) {
        ctx.ui.notify(
          `Resuming ${state.goal.policy === "list" ? "list item" : "goal"} [${state.goal.id}]: ${state.goal.objective.slice(0, 70)}${listQueue().length > 0 ? ` (+${listQueue().length} queued)` : ""}`,
          "info",
        );
        scheduleContinuation(ctx, true);
      } else {
        const queued = listQueue().length;
        // v0.22.7: name WHAT is held — a list head resumes through /list.
        const isListItem = state.goal.policy === "list";
        const resumeCmd = isListItem ? "/list resume" : "/goal resume";
        const resumeHint = `${resumeCmd} to continue${queued > 0 ? ` (+${queued} queued in the list)` : ""} · /glla autoresume=on to auto-resume in this project`;
        updateGoal({
          status: "paused",
          pauseReason: "restored in a fresh session — no work started",
          pauseSuggestedAction: resumeHint,
        }, ctx);
        ctx.ui.notify(
          `${isListItem ? "List item" : "Goal"} held on restore [${state.goal.id}]: ${state.goal.objective.slice(0, 70)}${queued > 0 ? ` (+${queued} queued in the list)` : ""} — ${resumeCmd} to continue.`,
          "info",
        );
      }
    } else if (state.goal && state.goal.status === "active") {
      // Active but autoContinue off: nothing auto-fires — just surface it.
      ctx.ui.notify(
        `Restored ${state.goal.policy === "list" ? "list item" : "goal"} [${state.goal.id}]: ${state.goal.objective.slice(0, 70)}${listQueue().length > 0 ? ` (+${listQueue().length} queued)` : ""}`,
        "info",
      );
    } else if ((!state.goal || state.goal.status === "complete" || state.goal.status === "aborted") && listQueue().length > 0) {
      if (autoResume) {
        // Session restarted with a non-empty queue but no active goal.
        activateNextListItem(ctx);
      } else {
        ctx.ui.notify(`List has ${listQueue().length} item(s) waiting — /list next to activate the head.`, "info");
      }
    }
    // Always paint on session load (v0.22.1): the branches above only reach
    // refreshUI via persistState, so a goal that was ALREADY paused (or any
    // state that doesn't mutate on load) rendered nothing — "can't tell if
    // it's on" is a bug. Painting unconditionally also clears/refreshes any
    // stale widget carried over from a previous in-process session.
    refreshUI(ctx);
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
            pauseSuggestedAction: "Inspect the goal — /goal resume to retry, /goal tweak to narrow it, /goal cancel to abort.",
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
      await runLoopTick(ctx, event);
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
    // token limit pauses it; /glla tokenlimit=<n> to raise.
    const newTokens = sumNewAssistantTokens(event.messages as unknown[], countedTokenMessages);
    if (newTokens > 0) {
      const used = (state.goal.usage?.tokensUsed ?? 0) + newTokens;
      const limit = state.goal.usage?.tokensLimit ?? DEFAULT_TOKEN_LIMIT;
      // v0.12.0: the guard is opt-in — limit 0/unset means never pause.
      if (limit > 0 && used > limit) {
        updateGoal({
          usage: { tokensUsed: used, tokensLimit: limit },
          status: "paused",
          pauseReason: `token limit exceeded (${used.toLocaleString()} > ${limit.toLocaleString()})`,
          pauseSuggestedAction: "/glla tokenlimit=<n> to raise the cap (or 0 to disable), then /goal resume",
        }, ctx);
        ctx.ui.notify(`Goal paused: token limit exceeded (${used.toLocaleString()} > ${limit.toLocaleString()}). /glla tokenlimit=<n> to raise, 0 to disable.`, "warning");
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
          pauseSuggestedAction: "Use /goal resume to retry, or /goal cancel to abort.",
        }, ctx);
        ctx.ui.notify("Goal paused: 5 consecutive errors.", "warning");
        notifyExternal(ctx, "Goal paused: 5 consecutive errors.");
        return;
      }
    } else {
      consecutiveErrorIterations = 0;
    }

    // No wall-clock cap by design: a goal ends via completion, explicit
    // pause/cancel, the stall watchdog, the 5-consecutive-errors pause, or
    // the token guard — never via an elapsed-time cutoff.

    scheduleContinuation(ctx, false);
  });

  pi.on("tool_call", () => {
    toolCallsThisTurn++;
    noteActivity();
  });
}
