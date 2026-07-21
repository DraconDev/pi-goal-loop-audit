// pi-goal-list-loop-audit — v0.8.1
// tests/list-import.test.ts
//
// Unit tests for bulk list-import parsing (the sisyphus-style plan path).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import * as assert from "node:assert/strict";

import { parseListImport, resolveImportFile } from "../extensions/goal-loop-core.ts";

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
