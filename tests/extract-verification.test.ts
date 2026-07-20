// pi-goal-loop-audit — v0.1.0
// tests/extract-verification.test.ts
//
// Smoke tests for the inline extractVerificationContract we use in loops/goal.ts.
// We re-implement the function here to test the logic in isolation rather than
// importing the orchestrator (which requires a live ExtensionContext).
//
// v0.1.0: extract contract lives inside the orchestrator.
// v0.2.0: hoists it to goal-loop-draft.ts and consumes the same logic.

import { test } from "node:test";
import * as assert from "node:assert/strict";

function extractVerificationContract(raw: string): { objective: string; verificationContract: string } {
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

test("no marker returns full text as objective", () => {
  const r = extractVerificationContract("Step 1. Step 2.");
  assert.equal(r.objective, "Step 1. Step 2.");
  assert.equal(r.verificationContract, "");
});

test("'Done when:' splits correctly", () => {
  const r = extractVerificationContract("Make the test pass.\nDone when: npm test exits 0");
  assert.equal(r.objective, "Make the test pass.");
  assert.equal(r.verificationContract, "Done when: npm test exits 0");
});

test("'Verify:' alias works", () => {
  const r = extractVerificationContract("Add widget.\nVerify: grep widget foo.ts");
  assert.equal(r.objective, "Add widget.");
  assert.equal(r.verificationContract, "Verify: grep widget foo.ts");
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
