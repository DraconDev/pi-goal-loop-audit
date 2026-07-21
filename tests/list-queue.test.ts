// pi-goal-list-loop-audit — v0.2.0
// tests/list-queue.test.ts
//
// Unit tests for loop 2 (/list): queue persistence + state restore.
// The activation flow (activateNextListItem) needs an ExtensionContext, so
// it's covered by the live tmux smoke instead; here we pin the pure parts:
// readState restoring `list` from the ledger, and round-trip of queue events.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import * as assert from "node:assert/strict";

import {
  appendLedger,
  newGoalId,
  nowIso,
  readState,
  takeAt,
} from "../extensions/goal-loop-core.ts";

function tmpCwd(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-gla-list-test-"));
}

test("readState restores an empty list when no state exists", () => {
  const cwd = tmpCwd();
  try {
    const s = readState(cwd);
    assert.equal(s.goal, null);
    assert.deepEqual(s.list, []);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("readState restores list from the latest state event", () => {
  const cwd = tmpCwd();
  try {
    const item = { id: newGoalId(), objective: "do thing one", addedAt: nowIso() };
    const item2 = { id: newGoalId(), objective: "do thing two", addedAt: nowIso() };
    appendLedger(cwd, "state", { goal: null, list: [item, item2] });
    const s = readState(cwd);
    assert.equal(s.goal, null);
    assert.equal(s.list!.length, 2);
    assert.equal(s.list![0]!.objective, "do thing one");
    assert.equal(s.list![1]!.objective, "do thing two");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("latest state event wins for the list", () => {
  const cwd = tmpCwd();
  try {
    const item = { id: newGoalId(), objective: "first", addedAt: nowIso() };
    appendLedger(cwd, "state", { goal: null, list: [item] });
    appendLedger(cwd, "state", { goal: null, list: [] }); // cleared
    const s = readState(cwd);
    assert.deepEqual(s.list, []);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("list events (list_added etc.) do not corrupt state restore", () => {
  const cwd = tmpCwd();
  try {
    const item = { id: newGoalId(), objective: "queued", addedAt: nowIso() };
    appendLedger(cwd, "state", { goal: null, list: [item] });
    appendLedger(cwd, "list_added", { id: item.id, objective: item.objective });
    appendLedger(cwd, "goal_created", { goalId: "x", objective: "y", policy: "list" });
    const s = readState(cwd);
    assert.equal(s.list!.length, 1);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("state event without a list field restores as empty list (v0.1.0 compat)", () => {
  const cwd = tmpCwd();
  try {
    // v0.1.0 wrote { goal } only — must not break on upgrade.
    appendLedger(cwd, "state", { goal: null });
    const s = readState(cwd);
    assert.equal(s.goal, null);
    assert.deepEqual(s.list, []);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("takeAt: head is the FIFO default", () => {
  const r = takeAt(["a", "b", "c"], 1)!;
  assert.equal(r[0], "a");
  assert.deepEqual(r[1], ["b", "c"]);
});

test("takeAt: middle item", () => {
  const r = takeAt(["a", "b", "c"], 2)!;
  assert.equal(r[0], "b");
  assert.deepEqual(r[1], ["a", "c"]);
});

test("takeAt: last item", () => {
  const r = takeAt(["a", "b", "c"], 3)!;
  assert.equal(r[0], "c");
  assert.deepEqual(r[1], ["a", "b"]);
});

test("takeAt: out of range returns null", () => {
  assert.equal(takeAt(["a"], 0), null);
  assert.equal(takeAt(["a"], 2), null);
  assert.equal(takeAt([], 1), null);
  assert.equal(takeAt(["a"], 1.5), null);
});
