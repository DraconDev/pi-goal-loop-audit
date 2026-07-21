// pi-goal-list-loop-audit — v0.5.0
// tests/heartbeat.test.ts
//
// Unit tests for the heartbeat self-watchdog: stall detection and
// nudge accounting. This replaces the external pi-compaction-continue
// plugin for our loops — liveness is the loop's own job.

import { test } from "node:test";
import * as assert from "node:assert/strict";

import {
  accountTurnForNudges,
  HEARTBEAT_MAX_NUDGES,
  HEARTBEAT_STALL_MS,
  shouldHeartbeatRefire,
} from "../extensions/goal-loop-backoff.ts";

// ---- shouldHeartbeatRefire ----

test("fires: supervising + idle + no timer + quiet long enough", () => {
  assert.equal(shouldHeartbeatRefire({
    supervising: true,
    sessionIdle: true,
    timerPending: false,
    msSinceActivity: HEARTBEAT_STALL_MS,
  }), true);
});

test("does not fire when not supervising", () => {
  assert.equal(shouldHeartbeatRefire({
    supervising: false,
    sessionIdle: true,
    timerPending: false,
    msSinceActivity: HEARTBEAT_STALL_MS * 10,
  }), false);
});

test("does not fire when session is busy", () => {
  assert.equal(shouldHeartbeatRefire({
    supervising: true,
    sessionIdle: false,
    timerPending: false,
    msSinceActivity: HEARTBEAT_STALL_MS * 10,
  }), false);
});

test("does not fire when a continuation is already scheduled", () => {
  assert.equal(shouldHeartbeatRefire({
    supervising: true,
    sessionIdle: true,
    timerPending: true,
    msSinceActivity: HEARTBEAT_STALL_MS * 10,
  }), false);
});

test("does not fire before the stall threshold", () => {
  assert.equal(shouldHeartbeatRefire({
    supervising: true,
    sessionIdle: true,
    timerPending: false,
    msSinceActivity: HEARTBEAT_STALL_MS - 1,
  }), false);
});

test("custom stall threshold is honored", () => {
  assert.equal(shouldHeartbeatRefire({
    supervising: true,
    sessionIdle: true,
    timerPending: false,
    msSinceActivity: 5_000,
    stallMs: 5_000,
  }), true);
});

// ---- accountTurnForNudges ----

test("zero-tool turn increments the nudge count", () => {
  assert.equal(accountTurnForNudges(0, 0), 1);
  assert.equal(accountTurnForNudges(0, 1), 2);
  assert.equal(accountTurnForNudges(0, 2), HEARTBEAT_MAX_NUDGES);
});

test("tool-using turn resets the count", () => {
  assert.equal(accountTurnForNudges(1, 2), 0);
  assert.equal(accountTurnForNudges(7, 0), 0);
});
