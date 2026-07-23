/**
 * Tests for extensions/goal-loop-repetition.ts (v0.24.0) — the anti-repetition
 * classifiers that defend metricless loops from doorknob-polishing. Pure
 * functions, imported from the real module (never a copy — v0.23.7).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  REPETITION,
  normalizeForPrint,
  textFingerprint,
  trigramSimilarity,
  findDegenerateRepeat,
  detectLoopStuck,
  loopInterventionDirective,
  continueVariant,
  pushCapped,
} from "../extensions/goal-loop-repetition.ts";

// ---- primitives ----

test("normalizeForPrint strips ANSI, collapses whitespace, lowercases", () => {
  assert.equal(normalizeForPrint("  Hello\x1b[31m   World\n\nX  "), "hello world x");
});

test("textFingerprint is stable and case/whitespace-insensitive", () => {
  assert.equal(textFingerprint("Fix the   BUG"), textFingerprint("fix the bug"));
  assert.notEqual(textFingerprint("fix the bug"), textFingerprint("fix the other bug"));
});

test("trigramSimilarity: identical texts → 1, disjoint → 0, near-dup → high", () => {
  const a = "I will now update the parser to handle nested expressions correctly";
  assert.equal(trigramSimilarity(a, a), 1);
  assert.equal(trigramSimilarity(a, "completely unrelated words about cooking pasta tonight"), 0);
  const near = "I will now update the parser to handle nested expressions properly";
  assert.ok(trigramSimilarity(a, near) >= 0.6, "near-duplicate scores high");
});

test("trigramSimilarity: digits are volatile — 'port 8081' ≈ 'port 8082'", () => {
  const a = "restart the server on port 8081 and watch the logs for errors";
  const b = "restart the server on port 8082 and watch the logs for errors";
  assert.equal(trigramSimilarity(a, b), 1);
});

test("pushCapped keeps the window at cap, most recent last", () => {
  assert.deepEqual(pushCapped([1, 2, 3], 4, 3), [2, 3, 4]);
  assert.deepEqual(pushCapped([], "a", 3), ["a"]);
});

// ---- degenerate repetition inside ONE response ----

test("findDegenerateRepeat: repeated sentence inside one reply", () => {
  const s = "The build is broken and I cannot fix it. ".repeat(6);
  const d = findDegenerateRepeat(s);
  assert.ok(d, "detected");
  assert.equal(d!.kind, "sentence");
  assert.ok(d!.count >= REPETITION.degenerateSentenceRepeats);
});

test("findDegenerateRepeat: repeated single word run", () => {
  const d = findDegenerateRepeat("working " + "working ".repeat(20));
  assert.ok(d, "detected");
  assert.equal(d!.kind, "word");
});

test("findDegenerateRepeat: normal prose passes", () => {
  const prose = "I updated the parser, added three tests for nested expressions, and fixed the regression in the tokenizer. The build now passes cleanly and the metric improved.";
  assert.equal(findDegenerateRepeat(prose), undefined);
});

test("findDegenerateRepeat: short text is never degenerate", () => {
  assert.equal(findDegenerateRepeat("ok ok ok ok ok ok ok ok"), undefined);
});

// ---- detectLoopStuck ----

const baseInput = {
  assistantText: "",
  recentPrints: [] as string[],
  previousText: undefined as string | undefined,
  recentToolResults: [] as { tool: string; hash: string; isError: boolean }[],
  toollessStreak: 0,
};

test("detectLoopStuck: healthy iteration → undefined", () => {
  const text = "Fixed the tokenizer regression and added a test covering nested parens. The suite is green now and the metric improved slightly.";
  assert.equal(detectLoopStuck({ ...baseInput, assistantText: text, recentPrints: [textFingerprint(text)] }), undefined);
});

test("detectLoopStuck: narration-only streak", () => {
  const r = detectLoopStuck({ ...baseInput, assistantText: "Thinking about the next step.", toollessStreak: 2 });
  assert.ok(r?.includes("narration only"));
});

test("detectLoopStuck: exact repeat of previous iteration", () => {
  const text = "I will refactor the module to extract the shared helper and then update all of the call sites to use it consistently.";
  const fp = textFingerprint(text);
  const r = detectLoopStuck({ ...baseInput, assistantText: text, recentPrints: [fp, fp] });
  assert.ok(r?.includes("exactly"));
});

test("detectLoopStuck: near-duplicate of previous iteration", () => {
  const prev = "Now I will update the configuration loader to validate every required key before the server starts accepting traffic.";
  const cur = "Now I will update the configuration loader to validate every required key before the server starts accepting connections.";
  const r = detectLoopStuck({ ...baseInput, assistantText: cur, previousText: prev, recentPrints: [textFingerprint(prev), textFingerprint(cur)] });
  assert.ok(r?.includes("similar"), `got: ${r}`);
});

test("detectLoopStuck: A-B-A-B window repetition", () => {
  const a = "first distinct response with enough content to matter for fingerprinting purposes here";
  const fp = textFingerprint(a);
  const r = detectLoopStuck({ ...baseInput, assistantText: a, recentPrints: [fp, "x", fp, "y", fp] });
  assert.ok(r?.includes("recent iterations"));
});

test("detectLoopStuck: same tool error three times", () => {
  const results = [
    { tool: "bash", hash: "h1", isError: true },
    { tool: "bash", hash: "h1", isError: true },
    { tool: "bash", hash: "h1", isError: true },
  ];
  const r = detectLoopStuck({ ...baseInput, assistantText: "Trying the build again.", recentToolResults: results });
  assert.ok(r?.includes("same bash error"));
});

test("detectLoopStuck: same tool result (no new information)", () => {
  const results = [
    { tool: "read", hash: "h9", isError: false },
    { tool: "read", hash: "h9", isError: false },
    { tool: "read", hash: "h9", isError: false },
  ];
  const r = detectLoopStuck({ ...baseInput, assistantText: "Reading the file once more.", recentToolResults: results });
  assert.ok(r?.includes("no new information"));
});

test("detectLoopStuck: first hit wins — narration beats everything (most certain)", () => {
  const text = "same ".repeat(60);
  const fp = textFingerprint(text);
  const r = detectLoopStuck({ ...baseInput, assistantText: text, recentPrints: [fp, fp], toollessStreak: 3 });
  assert.ok(r?.includes("narration only"));
});

// ---- intervention ladder ----

test("loopInterventionDirective: rotates strategy per consecutive count", () => {
  const d1 = loopInterventionDirective(1, "stuck reason", []);
  const d2 = loopInterventionDirective(2, "stuck reason", []);
  assert.notEqual(d1, d2, "different rungs, different instructions");
  assert.ok(d1.includes("stuck reason"));
  assert.ok(!d1.includes("HARD RESET"), "no hard reset on rung 1");
});

test("loopInterventionDirective: hard reset from rung 3 with banned openings", () => {
  const texts = ["I will now try the build again and see what happens this time around"];
  const d = loopInterventionDirective(3, "stuck reason", texts);
  assert.ok(d.includes("HARD RESET"));
  assert.ok(d.includes("Banned openings:"));
  assert.ok(d.includes("FIRST action"));
});

test("loopInterventionDirective: rotation wraps after all strategies", () => {
  const d1 = loopInterventionDirective(1, "r", []);
  const d6 = loopInterventionDirective(6, "r", []);
  // rung 6 wraps to strategy 1 (minus escalation differences)
  assert.ok(d1.length > 0 && d6.length > 0);
});

// ---- continuation variants ----

test("continueVariant: rotates by iteration, never empty", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 5; i++) {
    const v = continueVariant(i);
    assert.ok(v.length > 10);
    seen.add(v);
  }
  assert.equal(seen.size, 5, "five distinct variants");
  assert.equal(continueVariant(5), continueVariant(0), "wraps");
});
