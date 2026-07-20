/**
 * pi-goal-loop-audit — v0.1.0
 * tests/goal-loop-core.test.ts
 *
 * Smoke tests for the core state machine, schema, and renderer.
 * These do not depend on pi; they exercise pure logic.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import * as assert from "node:assert/strict";

import {
  type Goal,
  appendLedger,
  archivedGoalPath,
  buildTaskSummary,
  ensureDirs,
  findNextPendingTask,
  goalMdPath,
  ledgerPath,
  newGoalId,
  nowIso,
  piGlaDir,
  readGoalMd,
  readState,
  renderGoalMarkdown,
  statusLabel,
  writeGoalMd,
} from "../extensions/goal-loop-core.ts";
import {
  BACKOFF_HARD_CAP_MS,
  backoffMs,
  humanMs,
  shouldPauseAfterBackoff,
} from "../extensions/goal-loop-backoff.ts";

// ---- helpers ----

function tmpCwd(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "pi-gla-test-"));
  return d;
}

// ---- tests ----

test("piGlaDir returns the canonical path", () => {
  assert.equal(piGlaDir("/x/y"), path.join("/x/y", ".pi-gla"));
});

test("newGoalId format", () => {
  const id = newGoalId();
  assert.match(id, /^\d{14}-[a-z0-9]{6}$/);
});

test("statusLabel covers all states", () => {
  assert.equal(statusLabel("active"), "active");
  assert.equal(statusLabel("auditing"), "auditing");
  assert.equal(statusLabel("complete"), "complete");
  assert.equal(statusLabel("paused"), "paused");
  assert.equal(statusLabel("aborted"), "aborted");
  assert.equal(statusLabel(null), "no goal");
});

test("backoffMs caps at 5 min", () => {
  assert.equal(backoffMs(0, "stuck"), 0);
  assert.equal(backoffMs(1, "stuck"), 30_000);
  assert.equal(backoffMs(2, "stuck"), 60_000);
  assert.equal(backoffMs(3, "stuck"), 120_000);
  assert.equal(backoffMs(4, "stuck"), 240_000);
  assert.equal(backoffMs(5, "stuck"), BACKOFF_HARD_CAP_MS);  // 5 min cap
  assert.equal(backoffMs(100, "stuck"), BACKOFF_HARD_CAP_MS); // never exceeds 5 min
});

test("backoffMs error mode exponential", () => {
  assert.equal(backoffMs(0, "error"), 5_000);
  // Note: our error mode uses (count - 1) exponent; verify it doesn't exceed max.
  assert.ok(backoffMs(50, "error") <= 60_000);
});

test("shouldPauseAfterBackoff", () => {
  assert.ok(shouldPauseAfterBackoff(BACKOFF_HARD_CAP_MS, 1));  // exactly the cap
  assert.ok(shouldPauseAfterBackoff(BACKOFF_HARD_CAP_MS + 1000, 1));
  assert.ok(shouldPauseAfterBackoff(10_000, 3)); // 3 empty turns
  assert.ok(!shouldPauseAfterBackoff(60_000, 1));
});

test("humanMs formatting", () => {
  assert.equal(humanMs(0), "0ms");
  assert.equal(humanMs(500), "500ms");
  assert.equal(humanMs(1500), "2s");
  assert.equal(humanMs(60_000), "1m");
  assert.equal(humanMs(120_000), "2m");
  assert.equal(humanMs(300_000), "5m"); // the cap
});

test("findNextPendingTask BFSes subtasks", () => {
  const tasks = [
    {
      id: "1",
      title: "first",
      status: "complete" as const,
      subtasks: [
        { id: "1.1", title: "a", status: "complete" as const },
        { id: "1.2", title: "b", status: "pending" as const },
      ],
    },
    { id: "2", title: "second", status: "pending" as const },
  ];
  const next = findNextPendingTask(tasks);
  assert.ok(next);
  // BFS pops in order: 1 (complete, push subtasks), then 2 (pending) before 1.2.
  // So the next pending task is the sibling at depth 1, not the deeper subtask.
  assert.equal(next!.id, "2");
});

test("findNextPendingTask returns subtask when no sibling pending", () => {
  const tasks = [
    {
      id: "1",
      title: "first",
      status: "complete" as const,
      subtasks: [
        { id: "1.1", title: "a", status: "complete" as const },
        { id: "1.2", title: "b", status: "pending" as const },
      ],
    },
  ];
  const next = findNextPendingTask(tasks);
  assert.ok(next);
  assert.equal(next!.id, "1.2");
});

test("buildTaskSummary counts complete", () => {
  const tasks = [
    { id: "1", title: "a", status: "complete" as const },
    { id: "2", title: "b", status: "pending" as const },
    { id: "3", title: "c", status: "complete" as const },
  ];
  assert.equal(buildTaskSummary(tasks), "2/3 done");
});

test("renderGoalMarkdown renders sections", () => {
  const goal: Goal = {
    id: "test-1",
    objective: "Make widget foo.",
    status: "active",
    policy: "goal",
    autoContinue: true,
    verificationContract: "npm test (0 failures)",
    usage: { tokensUsed: 100, tokensLimit: 1000 },
    createdAt: "2026-07-19T00:00:00Z",
    updatedAt: "2026-07-19T00:00:00Z",
  };
  const md = renderGoalMarkdown(goal);
  assert.ok(md.includes("# Goal"));
  assert.ok(md.includes("## Objective"));
  assert.ok(md.includes("Make widget foo."));
  assert.ok(md.includes("## Verification contract"));
  assert.ok(md.includes("npm test"));
});

test("writeGoalMd persists + readGoalMd returns", () => {
  const cwd = tmpCwd();
  try {
    const goal: Goal = {
      id: "test-2",
      objective: "Test write.",
      status: "active",
      policy: "goal",
      autoContinue: true,
      usage: { tokensUsed: 0, tokensLimit: 1000 },
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    writeGoalMd(cwd, goal);
    assert.ok(fs.existsSync(goalMdPath(cwd, "test-2")));
    assert.ok(readGoalMd(cwd, "test-2")!.includes("Test write."));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("readState returns default when no ledger", () => {
  const cwd = tmpCwd();
  try {
    const s = readState(cwd);
    assert.equal(s.goal, null);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("appendLedger + readState roundtrip", () => {
  const cwd = tmpCwd();
  try {
    appendLedger(cwd, "test_event", { foo: "bar" });
    assert.ok(fs.existsSync(ledgerPath(cwd)));
    appendLedger(cwd, "state", { goal: null });
    const s = readState(cwd);
    assert.equal(s.goal, null);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("ensureDirs creates the .pi-gla tree", () => {
  const cwd = tmpCwd();
  try {
    ensureDirs(cwd);
    assert.ok(fs.existsSync(path.join(cwd, ".pi-gla", "goals")));
    assert.ok(fs.existsSync(path.join(cwd, ".pi-gla", "archive")));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
