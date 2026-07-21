// pi-goal-loop-audit — v0.9.0
// tests/display.test.ts
//
// Unit tests for the live-TUI display builders: status line + widget lines.

import { test } from "node:test";
import * as assert from "node:assert/strict";

import {
  buildStatusText,
  buildWidgetLines,
  fmtElapsed,
  fmtTokens,
  truncate,
} from "../extensions/goal-loop-display.ts";
import type { Goal, State } from "../extensions/goal-loop-core.ts";
import type { LoopState } from "../extensions/goal-loop-forever.ts";

const NOW = Date.parse("2026-07-21T12:00:00Z");

function goalOf(overrides: Partial<Goal> = {}): Goal {
  return {
    id: "20260721120000-abcdef",
    objective: "Create x.txt containing ok",
    status: "active",
    policy: "goal",
    autoContinue: true,
    usage: { tokensUsed: 12_400, tokensLimit: 1_000_000 },
    createdAt: "2026-07-21T11:57:00Z",
    updatedAt: "2026-07-21T11:57:00Z",
    ...overrides,
  };
}

// ---- formatters ----

test("fmtElapsed", () => {
  assert.equal(fmtElapsed(500), "0s");
  assert.equal(fmtElapsed(45_000), "45s");
  assert.equal(fmtElapsed(180_000), "3m");
  assert.equal(fmtElapsed(3_900_000), "1h5m");
});

test("fmtTokens", () => {
  assert.equal(fmtTokens(500), "500");
  assert.equal(fmtTokens(12_400), "12.4k");
  assert.equal(fmtTokens(1_000_000), "1000k");
});

test("truncate", () => {
  assert.equal(truncate("short", 10), "short");
  assert.equal(truncate("a much longer string", 8), "a much …");
});

// ---- buildStatusText ----

test("empty state → undefined (segment cleared)", () => {
  assert.equal(buildStatusText({ goal: null, list: [] }, null, NOW), undefined);
});

test("active goal shows pulse + elapsed", () => {
  const s = buildStatusText({ goal: goalOf(), list: [] }, null, NOW)!;
  assert.match(s, /gla: goal ●/);
  assert.match(s, /3m/);
});

test("active goal with tasks shows progress", () => {
  const g = goalOf({
    taskList: {
      version: 1,
      tasks: [
        { id: "1", title: "a", status: "complete" },
        { id: "2", title: "b", status: "pending" },
      ],
    },
  });
  assert.match(buildStatusText({ goal: g, list: [] }, null, NOW)!, /1\/2 tasks/);
});

test("queue depth shows for list policy", () => {
  const s = buildStatusText(
    { goal: goalOf({ policy: "list" }), list: [{ id: "x", objective: "y", addedAt: "z" }] },
    null,
    NOW,
  )!;
  assert.match(s, /queue 1/);
});

test("paused shows the reason", () => {
  const g = goalOf({ status: "paused", pauseReason: "auditor disapproved: missing tests" });
  assert.match(buildStatusText({ goal: g, list: [] }, null, NOW)!, /paused ⏸ auditor disapproved/);
});

test("auditing shows the auditor's current tool", () => {
  const g = goalOf({ status: "auditing" });
  const s = buildStatusText({ goal: g, list: [] }, { currentTool: "read" }, NOW)!;
  assert.match(s, /auditing…/);
  assert.match(s, /read/);
});

test("complete goal clears the segment", () => {
  assert.equal(buildStatusText({ goal: goalOf({ status: "complete" }), list: [] }, null, NOW), undefined);
});

test("active loop shows iteration + best + stall", () => {
  const loop: LoopState = {
    target: "reduce TODOs",
    measureCmd: "grep -c TODO x",
    direction: "min",
    iteration: 12,
    maxIterations: 50,
    plateauWindow: 5,
    stallCount: 2,
    bestValue: 41,
    lastValue: 43,
    active: true,
    history: [],
    startedAt: "2026-07-21T11:00:00Z",
  };
  const s = buildStatusText({ goal: null, list: [], loop }, null, NOW)!;
  assert.match(s, /loop ↓ iter 12\/50/);
  assert.match(s, /best 41/);
  assert.match(s, /stall 2\/5/);
});

// ---- buildWidgetLines ----

test("widget: nothing supervised → undefined", () => {
  assert.equal(buildWidgetLines({ goal: null, list: [] }, null, NOW), undefined);
});

test("widget: goal lines include objective, status, tokens, footer", () => {
  const lines = buildWidgetLines({ goal: goalOf(), list: [] }, null, NOW)!;
  assert.match(lines[0]!, /◆ Create x\.txt containing ok/);
  assert.ok(lines.some((l) => l.includes("12.4k/1000k tok")));
  assert.ok(lines.some((l) => l.includes("/goal status")));
});

test("widget: paused goal shows reason + suggestion", () => {
  const g = goalOf({
    status: "paused",
    pauseReason: "no tests found",
    pauseSuggestedAction: "add tests dir",
  });
  const lines = buildWidgetLines({ goal: g, list: [] }, null, NOW)!;
  assert.ok(lines.some((l) => l.includes("no tests found")));
  assert.ok(lines.some((l) => l.includes("add tests dir")));
});

test("widget: auditing shows auditor progress", () => {
  const g = goalOf({ status: "auditing" });
  const lines = buildWidgetLines({ goal: g, list: [] }, { label: "verifying contract", currentTool: "grep", elapsedMs: 42_000 }, NOW)!;
  assert.ok(lines.some((l) => l.includes("verifying contract")));
  assert.ok(lines.some((l) => l.includes("grep")));
  assert.ok(lines.some((l) => l.includes("42s")));
});

test("widget: loop lines include measure + metric state", () => {
  const loop: LoopState = {
    target: "reduce TODOs",
    measureCmd: "grep -c TODO src.txt | head -1",
    direction: "min",
    iteration: 3,
    maxIterations: 12,
    plateauWindow: 3,
    stallCount: 1,
    bestValue: 2,
    lastValue: 3,
    active: true,
    history: [],
    startedAt: "2026-07-21T11:00:00Z",
    branchName: "pi-gla-loop/20260721-reduce-todos",
  };
  const lines = buildWidgetLines({ goal: null, list: [], loop }, null, NOW)!;
  assert.ok(lines.some((l) => l.includes("reduce TODOs")));
  assert.ok(lines.some((l) => l.includes("iter 3/12")));
  assert.ok(lines.some((l) => l.includes("best 2")));
  assert.ok(lines.some((l) => l.includes("pi-gla-loop/20260721-reduce-todos")));
});
