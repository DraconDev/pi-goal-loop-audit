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
  buildTaskSummary,
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
  BACKOFF_HARD_CAP_MS,
  BACKOFF_IDLE_RETRY_MS,
  backoffMs,
  humanMs,
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

function createGoal(objective: string, ctx: ExtensionContext): Goal {
  ensureDirs(ctx.cwd);
  // Extract verification contract if present in objective.
  const { objective: cleanObj, verificationContract } = extractVerificationContract(objective);
  const id = newGoalId();
  const goal: Goal = {
    id,
    objective: cleanObj,
    status: "active",
    policy: "goal",
    autoContinue: true,
    verificationContract: verificationContract || "",
    usage: { tokensUsed: 0, tokensLimit: 100_000 },
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  return goal;
}

function extractVerificationContract(raw: string): { objective: string; verificationContract: string } {
  // Look for "done when:" or "verify:" markers
  const lines = raw.split("\n");
  let mode: "obj" | "verify" = "obj";
  const objParts: string[] = [];
  const verifyParts: string[] = [];
  for (const line of lines) {
    const lower = line.toLowerCase();
    if (lower.match(/^\s*(?:done when|verify|verification|verified when|done):/)) {
      mode = "verify";
    }
    if (mode === "obj") objParts.push(line);
    else verifyParts.push(line);
  }
  return {
    objective: objParts.join("\n").trim(),
    verificationContract: verifyParts.join("\n").trim(),
  };
}

function setGoal(goal: Goal, ctx: ExtensionContext): void {
  state = { goal };
  const file = writeGoalMd(ctx.cwd, goal);
  state.goal!.activePath = path.relative(ctx.cwd, file) || file;
  appendLedger(ctx.cwd, "state", { goal: state.goal });
  appendLedger(ctx.cwd, "goal_created", { goalId: goal.id, objective: goal.objective });
}

function updateGoal(patch: Partial<Goal>, ctx: ExtensionContext): void {
  if (!state.goal) return;
  state.goal = { ...state.goal, ...patch, updatedAt: nowIso() };
  const file = writeGoalMd(ctx.cwd, state.goal);
  state.goal.activePath = path.relative(ctx.cwd, file) || file;
  appendLedger(ctx.cwd, "state", { goal: state.goal });
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
  state = { goal: { ...goal, status, archivedPath: path.relative(ctx.cwd, target) || target, stopReason } };
  appendLedger(ctx.cwd, "goal_archived", { goalId: goal.id, status, stopReason });
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
    ctx.ui.notify("Usage: /goal <objective with optional 'Done when: ...' verification clause>", "info");
    return;
  }
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
        });
        // Cap history — 39 infra errors taught us unbounded growth is real.
        if (history.length > 20) history.splice(0, history.length - 20);
      }

      if (result.approved) {
        updateGoal({ auditHistory: history }, ctx);
        archiveCurrentGoal(ctx, "complete", `auditor ${result.model} approved`);
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
}

// =================================================================
// Settings (auditor model, thinking level)
// =================================================================

interface Settings {
  /** "provider/model-id" or bare "model-id". Unset → session model. */
  auditorModel?: string;
  auditorThinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
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
  for (const part of trimmed.split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq).toLowerCase();
    const value = part.slice(eq + 1);
    if (key === "model" || key === "auditormodel") {
      next.auditorModel = value === "unset" ? undefined : value;
      changed = true;
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
    `Saved. auditorModel=${next.auditorModel ?? "(session model)"} thinking=${next.auditorThinkingLevel ?? "medium"}\n` +
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

const OUR_COMMANDS = ["goal", "goal-status", "goal-pause", "goal-resume", "goal-cancel", "goal-settings", "list", "loop"];
let collisionWarned = false;

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
  pi.registerCommand("goal-settings", {
    description: "Configure auditor model + thinking level (interactive prompt).",
    handler: (args: string, ctx: ExtensionContext) => { rememberCtx(ctx); return cmdSettings(args, ctx); },
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
    if (state.goal && state.goal.status === "active" && state.goal.autoContinue) {
      scheduleContinuation(ctx, true);
    }
  });

  pi.on("agent_end", async (event: any, ctx: ExtensionContext) => {
    rememberCtx(ctx);
    if (!registeredCtx) {
      registerAgentTools(pi, ctx);
      registeredCtx = ctx;
    }
    if (!state.goal) return;
    if (state.goal.status !== "active") return;
    clearContinuationTimer();

    const last = [...(event.messages as any[])].reverse().find((m) => m.role === "assistant");
    const text = last && Array.isArray(last.content) ? last.content.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n") : "";
    const stopReason = last?.stopReason;
    iterationCounter++;

    // Track tool calls in this turn (agent emits progress events; we don't have
    // per-turn list here without `before_tool_call`, so we approximate by checking
    // stopReason presence of tool_execution_end events. For v0.1.0 we just
    // acknowledge motion: if the assistant emitted text but no tools, that's a
    // sign of thinking-only loop, but we cannot detect it without the hook. So
    // we schedule a continuation regardless. The auditor catches rubber-stamps.

    if (stopReason === "error" || stopReason === "aborted") {
      consecutiveErrorIterations++;
      if (consecutiveErrorIterations >= 5) {
        updateGoal({
          status: "paused",
          pauseReason: `5 consecutive errors: ${stopReason}`,
          pauseSuggestedAction: "Use /goal-resume to retry, or /goal-cancel to abort.",
        }, ctx);
        ctx.ui.notify("Goal paused: 5 consecutive errors.", "warning");
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
  });
}
