// pi-goal-list-loop-audit
// tests/extract-verification.test.ts
//
// v0.23.7: imports the REAL extractVerificationContract from goal-loop-core.
// The pre-0.23.7 version of this file re-implemented the function in the
// test "to avoid importing the orchestrator" — the copy silently went stale
// (its header even pointed at a goal-loop-draft.ts that no longer exists).
// Testing a copy is testing nothing; the function lives in the pure module
// precisely so this file can import it.

import { test } from "node:test";
import * as assert from "node:assert/strict";

import { extractVerificationContract, goalArgsNeedDrafting, normalizeDraftContract } from "../extensions/goal-loop-core.ts";
import { contractItems } from "../extensions/goal-loop-shield.ts";

test("inline one-liner: 'Done when:' mid-line is extracted", () => {
  const r = extractVerificationContract("Create file x.txt containing ok. Done when: grep -q ok x.txt");
  assert.equal(r.objective, "Create file x.txt containing ok");
  assert.equal(r.verificationContract, "grep -q ok x.txt");
});

test("inline one-liner: trailing period stripped from objective", () => {
  const r = extractVerificationContract("Add the endpoint. Verify: curl returns 200");
  assert.equal(r.objective, "Add the endpoint");
  assert.equal(r.verificationContract, "curl returns 200");
});

test("no marker anywhere returns full text as objective", () => {
  const r = extractVerificationContract("Just do the thing please.");
  assert.equal(r.objective, "Just do the thing please.");
  assert.equal(r.verificationContract, "");
});

test("line-based extraction wins over inline when both present", () => {
  const r = extractVerificationContract("Build it.\nDone when:\n- tests pass");
  assert.equal(r.objective, "Build it.");
  assert.ok(r.verificationContract.includes("tests pass"));
});

test("multi-line verification contract preserved", () => {
  const r = extractVerificationContract(`
Step 1: write tests.
Step 2: ship.

Done when:
- npm test passes (0 failures)
- grep -r 'TODO' src/ returns nothing
- HEAD committed
`);
  assert.ok(r.objective.includes("Step 1"));
  assert.ok(r.verificationContract.includes("npm test"));
  assert.ok(r.verificationContract.includes("grep -r"));
});

// ---- v0.23.7: the "done when" family accepts text before the colon ----

test("line marker: 'Done when ALL of the following are true:' starts the contract", () => {
  const r = extractVerificationContract("Polish the routes.\nDone when ALL of the following are true:\n- route A renders\n- route B persists");
  assert.equal(r.objective, "Polish the routes.");
  assert.ok(r.verificationContract.includes("route A renders"));
});

test("inline marker: 'Done when ALL of the following are true:' mid-line", () => {
  const r = extractVerificationContract("Polish the routes. Done when ALL of the following are true: every route renders");
  assert.equal(r.objective, "Polish the routes");
  assert.equal(r.verificationContract, "every route renders");
});

test("goalArgsNeedDrafting: 'Done when ALL of the following' counts as a contract (no interview)", () => {
  assert.equal(goalArgsNeedDrafting("Fix X. Done when ALL of the following are true: a, b, c"), false);
  assert.equal(goalArgsNeedDrafting("make it better"), true);
});

// ---- v0.23.7: round-trip chain — what the draft dialog stores is what the
// shield later parses. normalizeDraftContract (render+store) → stored text →
// extractVerificationContract (list/tweak paths) → contractItems (shield).

test("round-trip: normalized draft survives storage and yields clean shield items", () => {
  const modelContract = "Done when ALL of the following are true:\n- combat-debug route renders without console errors\n- art-demo-v7 variants persist across reload";
  const normalized = normalizeDraftContract(modelContract);
  const stored = `Audit-driven fix-and-polish pass.\nDone when:\n${normalized}`;
  const extracted = extractVerificationContract(stored);
  assert.equal(extracted.objective, "Audit-driven fix-and-polish pass.");
  assert.deepEqual(contractItems(extracted.verificationContract), [
    "combat-debug route renders without console errors",
    "art-demo-v7 variants persist across reload",
  ]);
});
