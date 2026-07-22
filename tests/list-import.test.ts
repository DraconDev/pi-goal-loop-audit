// pi-goal-list-loop-audit — v0.8.1
// tests/list-import.test.ts
//
// Unit tests for bulk list-import parsing (the sisyphus-style plan path).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import * as assert from "node:assert/strict";

import { parseListImport, resolveImportFile, routeListText } from "../extensions/goal-loop-core.ts";

test("markdown checklist", () => {
  const items = parseListImport("- [ ] first task\n- [x] done task\n- [ ] third task");
  assert.deepEqual(items, ["first task", "done task", "third task"]);
});

test("bullets of all flavors", () => {
  const items = parseListImport("- dash\n* star\n• dot");
  assert.deepEqual(items, ["dash", "star", "dot"]);
});

test("numbered items", () => {
  const items = parseListImport("1. first\n2) second\n10. tenth");
  assert.deepEqual(items, ["first", "second", "tenth"]);
});

test("plain lines pass through", () => {
  const items = parseListImport("write the thing\ntest the thing\nship the thing");
  assert.deepEqual(items, ["write the thing", "test the thing", "ship the thing"]);
});

test("headings, blanks, comments, hr rules are skipped", () => {
  const items = parseListImport("# Plan\n\n## Phase 1\n<!-- note -->\n---\nactual item\n***\n___\nanother");
  assert.deepEqual(items, ["actual item", "another"]);
});

test("a sisyphus-style plan file imports clean", () => {
  const plan = `# Capture plan

## Setup
- [ ] scaffold the project
- [ ] wire the router

## Work
1. build the pages
2. add the endpoints
3. seed the data

## Verify
- run the full test suite
- check the build passes
`;
  const items = parseListImport(plan);
  assert.deepEqual(items, [
    "scaffold the project",
    "wire the router",
    "build the pages",
    "add the endpoints",
    "seed the data",
    "run the full test suite",
    "check the build passes",
  ]);
});

test("whitespace-only and empty content yields nothing", () => {
  assert.deepEqual(parseListImport(""), []);
  assert.deepEqual(parseListImport("\n\n  \n# only a heading\n"), []);
});

test("items with inline contracts survive intact", () => {
  const items = parseListImport("- [ ] Create x.txt. Done when: grep -q ok x.txt");
  assert.deepEqual(items, ["Create x.txt. Done when: grep -q ok x.txt"]);
});

// ---- resolveImportFile ----

test("resolveImportFile: detects a real file by bare name", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gla-rif-"));
  try {
    fs.writeFileSync(path.join(cwd, "plan.md"), "- [ ] item");
    assert.equal(resolveImportFile(cwd, "plan.md"), path.join(cwd, "plan.md"));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("resolveImportFile: detects paths with separators and ./", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gla-rif-"));
  try {
    fs.mkdirSync(path.join(cwd, "docs"));
    fs.writeFileSync(path.join(cwd, "docs", "todo.txt"), "x");
    assert.equal(resolveImportFile(cwd, "docs/todo.txt"), path.join(cwd, "docs", "todo.txt"));
    assert.equal(resolveImportFile(cwd, "./docs/todo.txt"), path.join(cwd, "docs", "todo.txt"));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("resolveImportFile: objective text is NOT a file", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gla-rif-"));
  try {
    assert.equal(resolveImportFile(cwd, "Create x.txt containing ok"), null);
    assert.equal(resolveImportFile(cwd, "plan.md"), null); // doesn't exist → objective
    assert.equal(resolveImportFile(cwd, "multi line\nobjective"), null);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("resolveImportFile: directories are not importable", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gla-rif-"));
  try {
    fs.mkdirSync(path.join(cwd, "subdir"));
    assert.equal(resolveImportFile(cwd, "subdir"), null);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

// v0.18.0: conversational /list — dump text, get a decomposed list
test("routeListText: file path wins over everything", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "glla-route-"));
  fs.writeFileSync(path.join(cwd, "plan.md"), "- a\n- b\n");
  const r = routeListText(cwd, "plan.md");
  assert.equal(r.kind, "file");
  fs.rmSync(cwd, { recursive: true, force: true });
});

test("routeListText: multi-line paste is an explicit batch", () => {
  const r = routeListText("/nonexistent", "fix x\ndo y\nclean z");
  assert.equal(r.kind, "batch");
  if (r.kind === "batch") assert.equal(r.items.length, 3);
});

test("routeListText: 'Done when:' clause adds directly, no interview", () => {
  const r = routeListText("/nonexistent", "fix the flaky login test. Done when: npm test is green");
  assert.equal(r.kind, "direct");
});

test("routeListText: vague dump goes to conversational drafting", () => {
  const r = routeListText("/nonexistent", "fix the login bug, add dark mode, write the docs");
  assert.equal(r.kind, "draft");
  if (r.kind === "draft") assert.equal(r.seed, "fix the login bug, add dark mode, write the docs");
});

test("routeListText: nonexistent file-ish text is not a file", () => {
  const r = routeListText("/nonexistent", "plan.md");
  assert.equal(r.kind, "draft"); // no Done-when → draft, not a usage error
});
