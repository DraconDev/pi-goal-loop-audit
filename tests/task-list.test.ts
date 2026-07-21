// pi-goal-list-loop-audit — v0.3.0
// tests/task-list.test.ts
//
// Unit tests for task-list proposal validation (the anti-drift caps) and
// hierarchical id assignment.

import { test } from "node:test";
import * as assert from "node:assert/strict";

import {
  buildTaskList,
  MAX_SUBTASKS_PER_TASK,
  MAX_TOP_LEVEL_TASKS,
  validateTaskProposal,
} from "../extensions/goal-loop-core.ts";

// ---- validateTaskProposal ----

test("accepts a reasonable breakdown", () => {
  const err = validateTaskProposal([
    { title: "write code", subtasks: ["draft", "review"] },
    { title: "test it" },
  ]);
  assert.equal(err, null);
});

test("rejects empty list", () => {
  assert.match(validateTaskProposal([])!, /empty/i);
});

test("rejects too many top-level tasks", () => {
  const tasks = Array.from({ length: MAX_TOP_LEVEL_TASKS + 1 }, (_, i) => ({ title: `t${i}` }));
  assert.match(validateTaskProposal(tasks)!, /max 20/);
});

test("rejects too many subtasks (the anti-drift cap)", () => {
  const subs = Array.from({ length: MAX_SUBTASKS_PER_TASK + 1 }, (_, i) => `s${i}`);
  const err = validateTaskProposal([{ title: "big", subtasks: subs }]);
  assert.match(err!, /max 5/);
  assert.match(err!, /big/);
});

test("accepts exactly at the cap", () => {
  const subs = Array.from({ length: MAX_SUBTASKS_PER_TASK }, (_, i) => `s${i}`);
  assert.equal(validateTaskProposal([{ title: "ok", subtasks: subs }]), null);
});

test("rejects empty titles", () => {
  assert.match(validateTaskProposal([{ title: "  " }])!, /title/);
});

// ---- buildTaskList ----

test("assigns hierarchical ids and pending statuses", () => {
  const tl = buildTaskList([
    { title: "first", subtasks: ["a", "b"] },
    { title: "second" },
  ]);
  assert.equal(tl.version, 1);
  assert.equal(tl.tasks.length, 2);
  assert.equal(tl.tasks[0]!.id, "1");
  assert.equal(tl.tasks[0]!.status, "pending");
  assert.equal(tl.tasks[0]!.subtasks![0]!.id, "1.1");
  assert.equal(tl.tasks[0]!.subtasks![1]!.id, "1.2");
  assert.equal(tl.tasks[1]!.id, "2");
  assert.deepEqual(tl.tasks[1]!.subtasks, []);
});

test("trims titles", () => {
  const tl = buildTaskList([{ title: "  padded  ", subtasks: ["  x "] }]);
  assert.equal(tl.tasks[0]!.title, "padded");
  assert.equal(tl.tasks[0]!.subtasks![0]!.title, "x");
});
