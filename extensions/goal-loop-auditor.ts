/**
 * pi-goal-list-loop-audit — v0.1.0
 * extensions/goal-loop-auditor.ts
 *
 * Isolated completion auditor. Runs in a fresh pi agent session with no
 * extensions, no skills, no prompts, no themes, no editor. Only read tools.
 *
 * Two enforced floors: the auditor must call at least one read tool before
 * <approved/>, and regression_shield (goal-loop-shield.ts) requires the
 * report to include raw output (cat / grep / bash) for every must-verify
 * item in the verification contract — the orchestrator rejects
 * evidence-free approvals.
 */

import type { Model } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  createAgentSession,
  createExtensionRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionContext,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";

import type { Goal } from "./goal-loop-core.js";
import { renderGoalMarkdown } from "./goal-loop-core.js";

// =================================================================
// Result type
// =================================================================

export interface GoalAuditorResult {
  approved: boolean;
  disapproved: boolean;
  output: string;
  model: string;
  thinkingLevel?: ThinkingLevel;
  error?: string;
  /** regression_shield outcome when the goal has a verification contract. */
  regressionShieldPassed?: boolean;
  regressionShieldMissing?: string[];
}

// =================================================================
// Audit log: every tool call the auditor made, with first ~120 chars of args.
// We use this to enforce "must call at least one tool" and (in v0.2.0)
// to enforce "must include raw evidence".
// =================================================================

export interface AuditProgress {
  recentOutput: string[];
  phase: "starting" | "running" | "thinking" | "tool_executing" | "producing_report" | "complete";
  elapsedMs: number;
  label?: string;
  percentage?: number;
  currentTool?: string;
  currentToolArgs?: string;
  currentToolStartedAt?: number;
  // Tool-call history for regression_shield:
  toolCalls: Array<{ name: string; argsPrefix: string; finishedAt: number }>;
}

export type AuditorProgressCallback = (progress: AuditProgress) => void;

// =================================================================
// Auditor resource loader — zero extensions, zero skills, zero prompts
// =================================================================

function makeAuditorResourceLoader(): ResourceLoader {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => [
      "You are a read-only completion auditor running in an isolated pi agent session.",
      "Inspect the repository and decide whether the claimed goal completion is genuinely satisfied.",
      "Never modify files. Never approve unless the actual user objective is complete.",
    ].join("\n"),
    getAppendSystemPrompt: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

// =================================================================
// Auditor prompt
// =================================================================

function buildGoalAuditorPrompt(goal: Goal, completionSummary: string | null | undefined, verificationSummary: string | null | undefined): string {
  const goalMd = renderGoalMarkdown(goal);
  // v0.22.6: if a previous audit APPROVED but the regression shield blocked
  // it, tell THIS run exactly which contract items went unreferenced — the
  // auditor quotes evidence for them explicitly and the loop converges
  // instead of repeating the same gap.
  const shieldGaps = [...(goal.auditHistory ?? [])].reverse().find((v) => v.regressionShieldPassed === false)?.regressionShieldMissing;
  return [
    "You are the independent completion auditor for pi-goal-list-loop-audit.",
    "The executor claims the goal is complete. Your job is to decide whether the user's objective is actually satisfied.",
    "Be skeptical and semantic. Do not approve from paperwork, intent, file count, word count, build success, or a plausible summary alone.",
    "Use read/grep/find/ls/bash as needed to inspect real artifacts. Do not mutate files or run destructive commands.",
    "If the work is only an alpha scaffold, generated template, shallow draft, proxy milestone, or lacks the user-facing value requested, disapprove.",
    "If any explicit requirement is missing, weakly verified, contradicted, or not inspectable with the available evidence, disapprove.",
    "Return a concise audit report. The final line MUST be exactly one of:",
    "<approved/>",
    "<disapproved/>",
    "",
    "Goal markdown (full state):",
    "<goal>",
    goalMd,
    "</goal>",
    "",
    "Executor completion claim:",
    "<completion_summary>",
    (completionSummary?.trim() || "(none provided)"),
    "</completion_summary>",
    ...(verificationSummary?.trim() ? [
      "",
      "Executor verification summary:",
      "<verification_summary>",
      verificationSummary.trim(),
      "</verification_summary>",
    ] : []),
    ...(goal.verificationContract?.trim() ? [
      "",
      "Goal verification contract (what the executor was required to verify):",
      "<verification_contract>",
      goal.verificationContract.trim(),
      "</verification_contract>",
    ] : []),
    ...(shieldGaps && shieldGaps.length > 0 ? [
      "",
      "REGRESSION SHIELD RETRY: a previous audit of yours ended in <approved/>, but the orchestrator blocked it",
      "because the report never referenced these contract items in its evidence:",
      ...shieldGaps.map((i) => `- ${i}`),
      "This time, address each of them explicitly: name the item and paste the raw output that proves it.",
    ] : []),
    "",
    "Audit checklist:",
    "1. Extract the real success criteria from the objective, including quality/reader outcomes.",
    "2. Inspect artifacts or command output that can prove or disprove those criteria.",
    ...(verificationSummary?.trim()
      ? ["3. Check the <verification_summary> against real artifacts. If the executor claims to have run tests or searched for references, verify those claims with actual file/shell evidence. The summary is a claim, not proof — cross-check it."]
      : []),
    ...(goal.verificationContract?.trim()
      ? ["4. Verify that the executor has satisfied every item in the <verification_contract>. If any item is missing or weakly addressed, disapprove."]
      : []),
    "5. Explain missing or weak evidence, especially scaffold-vs-final quality gaps.",
    "6. End with exactly <approved/> only if the objective is truly complete; otherwise end with exactly <disapproved/>.",
    ...(goal.verificationContract?.trim()
      ? [
          "",
          "REGRESSION SHIELD (mandatory because this goal has a verification contract):",
          "Your report MUST contain an <evidence> section. For EACH item in the verification contract,",
          "quote the item, then paste the RAW tool output that proves it (real bash/grep/read output,",
          "copied verbatim — not a paraphrase, not a description of what you saw). Format:",
          "",
          "<evidence>",
          "Item: <contract item 1>",
          "Output:",
          "<raw command output here>",
          "Item: <contract item 2>",
          "Output:",
          "<raw command output here>",
          "</evidence>",
          "",
          "An approval without a complete <evidence> section will be rejected automatically.",
        ]
      : []),
  ].join("\n");
}

// regression_shield lives in goal-loop-shield.ts (dependency-free, so unit
// tests can import it without pulling in pi). Re-exported for callers.
export { checkRegressionShield, contractItems, type RegressionShieldResult } from "./goal-loop-shield.js";
import { checkRegressionShield } from "./goal-loop-shield.js";

// =================================================================
// Auditor entry point
// =================================================================

export async function runGoalCompletionAuditor(args: {
  ctx: ExtensionContext;
  goal: Goal;
  completionSummary?: string | null;
  verificationSummary?: string | null;
  model?: Model<any>;
  thinkingLevel?: ThinkingLevel;
  signal?: AbortSignal;
  onProgress?: AuditorProgressCallback;
}): Promise<GoalAuditorResult> {
  const ctx = args.ctx;
  // Default to the session's current model when no dedicated auditor model is
  // configured (pi-goal-x's resolveAuditorModel does the same). A missing
  // auditor model must never be a silent audit failure.
  const model = args.model ?? ctx.model;
  const thinkingLevel = args.thinkingLevel ?? "medium";
  const outputParts: string[] = [];
  if (!model) {
    return { approved: false, disapproved: false, output: "", model: "(unset)", thinkingLevel, error: "no model (session model also unset)" };
  }
  const toolCalls: AuditProgress["toolCalls"] = [];

  try {
    const startedAt = Date.now();
    const progress: AuditProgress = {
      recentOutput: [],
      phase: "running",
      elapsedMs: 0,
      toolCalls,
    };
    function emitProgress(): void {
      progress.elapsedMs = Date.now() - startedAt;
      args.onProgress?.({ ...progress });
    }

    const { session } = await createAgentSession({
      cwd: ctx.cwd,
      model,
      thinkingLevel,
      // Pass the PARENT's ModelRuntime (v0.22.2). createAgentSession has no
      // "modelRegistry" option — passing the facade was silently ignored and
      // a FRESH runtime was built from auth.json/models.json, which has no
      // extension-registered providers. Streaming a model from such a
      // provider (e.g. one with a custom streamSimple wrapper) then failed
      // inside the stream and the auditor produced zero output. The facade
      // keeps the runtime in a TS-private field; reach it defensively and
      // fall back to the default (fresh runtime) if pi ever reshapes it.
      modelRuntime: (ctx.modelRegistry as any)?.runtime,
      resourceLoader: makeAuditorResourceLoader(),
      sessionManager: SessionManager.inMemory(ctx.cwd),
      // Compaction ENABLED (v0.4.0, closes pi-goal-x flaw #3: context exhaustion
      // mid-audit). Safety: regression_shield is orchestrator-side — if compaction
      // degrades the auditor's memory, its <evidence> block gets weaker and the
      // orchestrator disapproves. Compaction can never cause a false approval.
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: true } }),
      tools: ["read", "grep", "find", "ls", "bash"],
    });
    let streamError: string | undefined;
    const unsub = session.subscribe((event) => {
      // Capture provider/stream errors (401/403/429/credits) — these often
      // arrive as events rather than thrown exceptions, and without this they
      // surface as a silent empty report that looks like a disapproval.
      const anyEvent = event as any;
      if (anyEvent.type === "error" || anyEvent.error || anyEvent.type === "auto_retry_start") {
        const msg = anyEvent.error?.message ?? anyEvent.message ?? anyEvent.errorMessage;
        if (typeof msg === "string") streamError = msg.slice(0, 300);
      }
      if (event.type === "tool_execution_start") {
        progress.currentTool = event.toolName;
        progress.currentToolArgs = typeof event.args === "object" && event.args !== null
          ? JSON.stringify(event.args).slice(0, 120)
          : String(event.args ?? "").slice(0, 120);
        progress.currentToolStartedAt = Date.now();
        progress.phase = "tool_executing";
        emitProgress();
        return;
      }
      if (event.type === "tool_execution_end") {
        if (progress.currentTool) {
          toolCalls.push({
            name: progress.currentTool,
            argsPrefix: progress.currentToolArgs ?? "",
            finishedAt: Date.now(),
          });
        }
        progress.currentTool = undefined;
        progress.currentToolArgs = undefined;
        progress.currentToolStartedAt = undefined;
        progress.phase = "running";
        emitProgress();
        return;
      }
      if (event.type === "message_end") {
        const message = event.message as any;
        if (message?.role !== "assistant") return;
        // Stream failures surface as an assistant message with stopReason
        // "error" + errorMessage — NOT as an "error" event (v0.22.2: this
        // is why "unknown provider"/driver failures looked like a silent
        // empty report).
        if (message.stopReason === "error" && typeof message.errorMessage === "string" && message.errorMessage.trim()) {
          streamError = message.errorMessage.slice(0, 300);
        }
        for (const part of message.content ?? []) {
          if (part.type === "text" && typeof part.text === "string") outputParts.push(part.text);
        }
        const fullText = outputParts.join("\n\n");
        const lines = fullText.split("\n").filter((l: string) => l.trim());
        progress.recentOutput = lines.slice(-8);
        emitProgress();
        return;
      }
    });
    const abort = () => { session.abort(); };
    args.signal?.addEventListener("abort", abort, { once: true });

    progress.label = "Starting audit...";
    progress.percentage = 0;
    emitProgress();

    try {
      if (args.signal?.aborted) {
        return { approved: false, disapproved: false, output: "", model: modelLabel(model), thinkingLevel, error: "Auditor aborted." };
      }
      await session.prompt(buildGoalAuditorPrompt(args.goal, args.completionSummary, args.verificationSummary));
    } finally {
      unsub();
    }

    const output = outputParts.join("\n\n");

    // SILENT-FAILURE GUARD (v0.9.9, wild-caught): an auditor that produced
    // nothing — or produced text with no verdict marker — did not VERDICT.
    // That is an infrastructure result (dead model, quota, stream error),
    // not a disapproval, and must never be recorded as one.
    if (!output.trim()) {
      return {
        approved: false,
        disapproved: false,
        output,
        model: modelLabel(model),
        thinkingLevel,
        error: `Auditor produced no output${streamError ? `: ${streamError}` : " — the auditor session likely failed (check the model's auth/quota, or set a working one with /glla model=provider/id)"}`,
      };
    }

    const lastAssistant = [...outputParts].reverse().find((t) => /<\/?(approved|disapproved)\/>/i.test(t)) ?? output;
    const approved = /<approved\/>/i.test(lastAssistant);
    const disapproved = /<disapproved\/>/i.test(lastAssistant);

    if (!approved && !disapproved) {
      return {
        approved: false,
        disapproved: false,
        output,
        model: modelLabel(model),
        thinkingLevel,
        error: `Auditor produced no verdict marker (<approved/>/<disapproved/>)${streamError ? ` — stream error: ${streamError}` : ""}. Treating as an error, not a verdict.`,
      };
    }

    // v0.1.0 honesty: must call at least one read tool, otherwise it didn't really audit.
    const usedReadTool = toolCalls.some((c) => ["read", "grep", "find", "ls", "bash"].includes(c.name));

    if (approved && !usedReadTool) {
      return {
        approved: false,
        disapproved: true,
        output,
        model: modelLabel(model),
        thinkingLevel,
        error: "Auditor approved without calling any read tool; treated as disapproved.",
      };
    }

    // regression_shield: an approval against a verification contract must
    // carry per-item raw evidence, or it is converted to a disapproval.
    if (approved && args.goal.verificationContract?.trim()) {
      const shield = checkRegressionShield(output, args.goal.verificationContract);
      if (!shield.passed) {
        const why = !shield.hasEvidenceBlock
          ? "report has no <evidence> block"
          : `report's evidence does not address: ${shield.missingItems.join("; ")}`;
        return {
          approved: false,
          disapproved: true,
          output,
          model: modelLabel(model),
          thinkingLevel,
          error: `regression_shield: approved but ${why}`,
          regressionShieldPassed: false,
          regressionShieldMissing: shield.missingItems,
        };
      }
      progress.phase = "complete";
      emitProgress();
      return {
        approved,
        disapproved,
        output,
        model: modelLabel(model),
        thinkingLevel,
        regressionShieldPassed: true,
      };
    }

    progress.phase = "complete";
    emitProgress();
    return { approved, disapproved, output, model: modelLabel(model), thinkingLevel };
  } catch (err) {
    // v0.11.1 (audit critical): a runtime exception is INFRASTRUCTURE, never
    // a verdict. The three-way split identifies infra by `error &&
    // !disapproved` — setting disapproved here would silently route this to
    // the semantic-disapproval branch (the bug v0.9.9 was built to kill).
    return {
      approved: false,
      disapproved: false,
      output: "",
      model: modelLabel(model),
      thinkingLevel,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// =================================================================
// Model label helper
// =================================================================

function modelLabel(model: Model<any>): string {
  if (typeof model === "string") return model;
  if (model && typeof model === "object" && "id" in model) return (model as { id: string }).id;
  return "(unknown model)";
}
