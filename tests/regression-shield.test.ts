// pi-goal-list-loop-audit — v0.2.0
// tests/regression-shield.test.ts
//
// Unit tests for the regression_shield: contract item extraction and the
// evidence-enforcement check. This is the core anti-bamboozle hardening —
// the tests pin both the accept and reject paths.

import { test } from "node:test";
import * as assert from "node:assert/strict";

import {
  checkRegressionShield,
  contractItems,
} from "../extensions/goal-loop-shield.ts";

// ---- contractItems ----

test("contractItems: strips the 'Done when:' marker line", () => {
  const items = contractItems("Done when:\n- npm test passes\n- grep -q ok x.txt");
  assert.deepEqual(items, ["npm test passes", "grep -q ok x.txt"]);
});

test("contractItems: handles inline single-line contracts", () => {
  const items = contractItems("Done when: grep -q world hello.txt");
  assert.deepEqual(items, ["grep -q world hello.txt"]);
});

test("contractItems: strips bullets and numbering", () => {
  const items = contractItems("- first check\n* second check\n1. third check\n2) fourth check");
  assert.deepEqual(items, ["first check", "second check", "third check", "fourth check"]);
});

test("contractItems: drops empty lines", () => {
  const items = contractItems("one\n\n\n  \ntwo");
  assert.deepEqual(items, ["one", "two"]);
});

// ---- checkRegressionShield ----

const CONTRACT = "Done when:\n- curl returns 200 from /healthz\n- npm test exits 0";

test("passes: evidence block present, all items referenced", () => {
  const report = [
    "Audit report.",
    "<evidence>",
    "Item: curl returns 200 from /healthz",
    "Output:",
    "HTTP/1.1 200 OK",
    "Item: npm test exits 0",
    "Output:",
    "Tests: 12 passed, 0 failed",
    "</evidence>",
    "<approved/>",
  ].join("\n");
  const r = checkRegressionShield(report, CONTRACT);
  assert.equal(r.passed, true);
  assert.equal(r.hasEvidenceBlock, true);
  assert.deepEqual(r.missingItems, []);
});

test("rejects: approval without an evidence block", () => {
  const report = "I checked /healthz and npm test, both fine.\n<approved/>";
  const r = checkRegressionShield(report, CONTRACT);
  assert.equal(r.passed, false);
  assert.equal(r.hasEvidenceBlock, false);
});

test("rejects: evidence block but an item is not addressed", () => {
  const report = [
    "<evidence>",
    "Item: curl returns 200 from /healthz",
    "Output: HTTP/1.1 200 OK",
    "</evidence>",
    "<approved/>",
  ].join("\n");
  const r = checkRegressionShield(report, CONTRACT);
  assert.equal(r.passed, false);
  assert.equal(r.hasEvidenceBlock, true);
  assert.deepEqual(r.missingItems, ["npm test exits 0"]);
});

test("rejects: bamboozle-style empty evidence block", () => {
  const report = "<evidence>\n</evidence>\n<approved/>";
  const r = checkRegressionShield(report, CONTRACT);
  assert.equal(r.passed, false);
});

test("distinctive-token matching: references the item by a filename", () => {
  // The auditor may not quote the item verbatim; referencing hello.txt counts.
  const report = [
    "<evidence>",
    "Checked the file:",
    "$ cat hello.txt",
    "world",
    "$ grep -q world hello.txt && echo PASS",
    "PASS",
    "</evidence>",
    "<approved/>",
  ].join("\n");
  const r = checkRegressionShield(report, "Done when: grep -q world hello.txt");
  assert.equal(r.passed, true);
});

test("case-insensitive matching", () => {
  const report = "<evidence>\nItem: NPM TEST exits 0\nOutput: ok\n</evidence>\n<approved/>";
  const r = checkRegressionShield(report, "Done when:\n- npm test exits 0");
  assert.equal(r.passed, true);
});
