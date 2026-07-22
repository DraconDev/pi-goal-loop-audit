// pi-goal-list-loop-audit — v0.8.0
// tests/goal-route.test.ts
//
// Unit tests for /goal arg routing (top-level consolidation). The exact-match
// rule is the load-bearing behavior: an objective that STARTS with a
// subcommand word must still become a goal.

import { test } from "node:test";
import * as assert from "node:assert/strict";

import { askUserQuestionAnswered, buildSeedGrillMessage, draftProposalBlock, goalArgsNeedDrafting, routeGoalArgs } from "../extensions/goal-loop-core.ts";

test("empty args → draft", () => {
  assert.deepEqual(routeGoalArgs(""), { kind: "draft" });
  assert.deepEqual(routeGoalArgs("   "), { kind: "draft" });
});

test("exact subcommands route", () => {
  assert.deepEqual(routeGoalArgs("status"), { kind: "sub", name: "status", rest: "" });
  assert.deepEqual(routeGoalArgs("pause"), { kind: "sub", name: "pause", rest: "" });
  assert.deepEqual(routeGoalArgs("resume"), { kind: "sub", name: "resume", rest: "" });
  assert.deepEqual(routeGoalArgs("cancel"), { kind: "sub", name: "cancel", rest: "" });
});

test("subcommands are case-insensitive", () => {
  assert.deepEqual(routeGoalArgs("STATUS"), { kind: "sub", name: "status", rest: "" });
  assert.deepEqual(routeGoalArgs("Pause"), { kind: "sub", name: "pause", rest: "" });
});

test("tweak takes args", () => {
  assert.deepEqual(routeGoalArgs("tweak make it faster"), { kind: "sub", name: "tweak", rest: "make it faster" });
});

test("archive routes with or without args", () => {
  assert.deepEqual(routeGoalArgs("archive"), { kind: "sub", name: "archive", rest: "" });
});

test("CRITICAL: objective starting with 'pause' is a goal, not a subcommand", () => {
  assert.deepEqual(
    routeGoalArgs("pause the deployment pipeline and fix it"),
    { kind: "set", text: "pause the deployment pipeline and fix it" },
  );
});

test("CRITICAL: objective starting with 'status' is a goal", () => {
  assert.deepEqual(
    routeGoalArgs("status page should show green when healthy"),
    { kind: "set", text: "status page should show green when healthy" },
  );
});

test("objective starting with 'cancel' is a goal", () => {
  assert.deepEqual(
    routeGoalArgs("cancel the pending migration job"),
    { kind: "set", text: "cancel the pending migration job" },
  );
});

test("plain objectives set", () => {
  assert.deepEqual(
    routeGoalArgs("Create x.txt containing ok. Done when: grep -q ok x.txt"),
    { kind: "set", text: "Create x.txt containing ok. Done when: grep -q ok x.txt" },
  );
});

test("quoted objectives set (quote stripping happens downstream)", () => {
  assert.deepEqual(routeGoalArgs('"do the thing"'), { kind: "set", text: '"do the thing"' });
});

test("goalArgsNeedDrafting: vague objective needs drafting", () => {
  assert.equal(goalArgsNeedDrafting("audit the current state"), true);
  assert.equal(goalArgsNeedDrafting("fix the bug"), true);
});

test("goalArgsNeedDrafting: explicit contract activates instantly", () => {
  assert.equal(goalArgsNeedDrafting("Fix X Done when: tests pass"), false);
  assert.equal(goalArgsNeedDrafting("Ship it. Done when: npm publish succeeds"), false);
  assert.equal(goalArgsNeedDrafting("done when: clean tsc", ), false);
});

test("goalArgsNeedDrafting: empty is the no-args drafting path", () => {
  assert.equal(goalArgsNeedDrafting(""), false);
  assert.equal(goalArgsNeedDrafting("   "), false);
});

test("buildSeedGrillMessage: seed + tool + gate notice + grilling protocol", () => {
  const msg = buildSeedGrillMessage("[DRAFT]", "make the game faster", "propose_goal_draft");
  assert.match(msg, /make the game faster/);
  assert.match(msg, /propose_goal_draft/);
  assert.match(msg, /BLOCKED until the user has replied/);
  assert.match(msg, /ONE sharp, seed-specific question/);
  assert.match(msg, /non-answer/);
  assert.match(msg, /Do NOT activate the raw seed/);
});

test("draftProposalBlock: 0 replies → block with instructions, ≥1 → null", () => {
  const block = draftProposalBlock(0);
  assert.ok(block);
  assert.match(block!, /INTERVIEW FIRST/);
  assert.equal(draftProposalBlock(1), null);
  assert.equal(draftProposalBlock(5), null);
});


test("draftProposalBlock: escape hatch after 3 blocked proposals (v0.15.1)", () => {
  assert.match(draftProposalBlock(0)!, /INTERVIEW FIRST/);
  assert.doesNotMatch(draftProposalBlock(0, 2)!, /escape|type any chat/i);
  const hatched = draftProposalBlock(0, 3)!;
  assert.match(hatched, /type any chat message/i);
  assert.match(hatched, /Do NOT ask another interview question/);
  assert.equal(draftProposalBlock(1, 99), null); // floor met: never blocks
});

test("askUserQuestionAnswered: answered dialog counts, cancel/esc does not (v0.15.1)", () => {
  const answered = { answers: [{ question: "q", answer: "a" }], cancelled: false };
  assert.equal(askUserQuestionAnswered("ask_user_question", answered), true);
  // Esc-abandoned questionnaire must NOT open the gate
  assert.equal(askUserQuestionAnswered("ask_user_question", { answers: [], cancelled: true }), false);
  assert.equal(askUserQuestionAnswered("ask_user_question", { answers: [], cancelled: true, error: "no_ui" }), false);
  // empty answers without cancel is degenerate — no
  assert.equal(askUserQuestionAnswered("ask_user_question", { answers: [], cancelled: false }), false);
  // other tools never count
  assert.equal(askUserQuestionAnswered("bash", answered), false);
  // missing/garbage details never count
  assert.equal(askUserQuestionAnswered("ask_user_question", undefined), false);
  assert.equal(askUserQuestionAnswered("ask_user_question", "User has answered"), false);
});
