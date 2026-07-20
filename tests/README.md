# v0.1.0 — Tests

Run with:

```bash
npm test
```

The test script is:
```
node --experimental-strip-types --test tests/*.test.ts
```

## What is covered in v0.1.0

- **goal-loop-core.test.ts**: id generator, status labels, BFS for next pending task,
  task summary count, markdown rendering, file persistence, ledger append/read.
- **goal.schema.test.ts**: shape validation (type-only — full JSON Schema
  validation lands in v0.2.0).
- **extract-verification.test.ts**: inline contract extraction (no-marker,
  Done when, Verify alias, multi-line contract).

## What is NOT covered in v0.1.0

- Live pi session events (`agent_end`, `session_start`, `before_tool_call`).
- The auditor with a real model.
- Drafting phase (deferred to v0.2.0).

Live tests land in v0.2.0 alongside the regression_shield tests.

## Conventions

- All file paths in tests use `path.join` (cross-platform).
- We use `node:assert/strict` (not Jest) so it runs with Node 22+ only.
- Deno.test syntax is used (Node's `--experimental-strip-types` resolves it).
