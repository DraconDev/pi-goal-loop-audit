// pi-goal-list-loop-audit — v0.1.0 schema unit tests
//
// We don't run a JSON Schema validator here — instead these are
// fail-fast assertions on shape, so we catch regressions before publish.

import { test } from "node:test";
import * as assert from "node:assert/strict";

interface Goal {
  id: string;
  objective: string;
  status: "active" | "auditing" | "complete" | "paused" | "aborted";
  policy: "goal";
  autoContinue: boolean;
  usage: { tokensUsed: number; tokensLimit: number };
  createdAt: string;
  updatedAt: string;
}

// Lightweight shape check; full schema validation lands in v0.2.0.
function isValidShape(g: any): boolean {
  if (typeof g !== "object" || g === null) return false;
  const required = ["id", "objective", "status", "policy", "autoContinue", "usage", "createdAt", "updatedAt"];
  for (const k of required) if (!(k in g)) return false;
  if (!["active", "auditing", "complete", "paused", "aborted"].includes(g.status)) return false;
  if (g.policy !== "goal") return false;
  if (typeof g.autoContinue !== "boolean") return false;
  if (typeof g.usage.tokensUsed !== "number" || typeof g.usage.tokensLimit !== "number") return false;
  return true;
}

test("valid active goal passes shape check", () => {
  assert.equal(isValidShape({
    id: "x",
    objective: "do thing",
    status: "active",
    policy: "goal",
    autoContinue: true,
    usage: { tokensUsed: 0, tokensLimit: 1000 },
    createdAt: "2026-07-19T00:00:00Z",
    updatedAt: "2026-07-19T00:00:00Z",
  }), true);
});

test("invalid status is rejected", () => {
  assert.equal(isValidShape({
    id: "x",
    objective: "do thing",
    status: "BOGUS",
    policy: "goal",
    autoContinue: true,
    usage: { tokensUsed: 0, tokensLimit: 1000 },
    createdAt: "2026-07-19T00:00:00Z",
    updatedAt: "2026-07-19T00:00:00Z",
  }), false);
});

test("non-goal policy rejected in v0.1.0", () => {
  assert.equal(isValidShape({
    id: "x",
    objective: "do thing",
    status: "active",
    policy: "list",
    autoContinue: true,
    usage: { tokensUsed: 0, tokensLimit: 1000 },
    createdAt: "2026-07-19T00:00:00Z",
    updatedAt: "2026-07-19T00:00:00Z",
  }), false);
});

test("missing usage is rejected", () => {
  assert.equal(isValidShape({
    id: "x",
    objective: "do thing",
    status: "active",
    policy: "goal",
    autoContinue: true,
    createdAt: "2026-07-19T00:00:00Z",
    updatedAt: "2026-07-19T00:00:00Z",
  }), false);
});

test("missing required field is rejected", () => {
  assert.equal(isValidShape({
    id: "x",
    objective: "do thing",
    status: "active",
    policy: "goal",
    autoContinue: true,
    usage: { tokensUsed: 0, tokensLimit: 1000 },
    createdAt: "2026-07-19T00:00:00Z",
    // missing updatedAt
  }), false);
});
