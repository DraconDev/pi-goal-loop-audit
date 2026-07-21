/**
 * pi-goal-list-loop-audit — v0.2.0
 * extensions/goal-loop-shield.ts
 *
 * regression_shield — pure, dependency-free enforcement logic.
 *
 * When a goal has a verification contract, an <approved/> verdict is only
 * accepted if the auditor's report carries an <evidence> section that
 * references every contract item. This kills the "auditor ran bash true and
 * approved" class of bamboozle that pi-goal-x's author explicitly documented
 * as a known hole.
 *
 * Kept free of pi imports so unit tests can exercise it under plain node.
 */

/** Split a verification contract into its individual checkable items. */
export function contractItems(contract: string): string[] {
  return contract
    .split("\n")
    .map((l) => l.trim())
    .map((l) => l.replace(/^(?:done when|verify|verified when|verification|done)\s*:\s*/i, ""))
    .map((l) => l.replace(/^[-*•]\s+/, "").replace(/^\d+[.)]\s+/, ""))
    .filter((l) => l.length > 0);
}

export interface RegressionShieldResult {
  passed: boolean;
  missingItems: string[];
  hasEvidenceBlock: boolean;
}

/**
 * Check an approved auditor report against the verification contract.
 * Rules (deliberately simple + auditable):
 *   1. The report must contain an <evidence> ... </evidence> block.
 *   2. Every contract item must be referenced inside the report by a
 *      distinctive token (the item's longest word >= 5 chars, or the full
 *      item if shorter) — a cheap, honest proxy for "the auditor addressed
 *      this item".
 */
export function checkRegressionShield(report: string, contract: string): RegressionShieldResult {
  const hasEvidenceBlock = /<evidence>[\t\n\r ]*[\s\S]*?<\/evidence>/i.test(report);
  const items = contractItems(contract);
  const missingItems: string[] = [];
  const reportLower = report.toLowerCase();
  for (const item of items) {
    // Distinctive token: longest word >= 5 chars in the item; fall back to the
    // whole item (short items like "npm test" are matched whole).
    const words = item.split(/[^A-Za-z0-9_.\-/]+/).filter(Boolean);
    const distinctive = words.reduce((a, b) => (b.length >= 5 && b.length > a.length ? b : a), "");
    const needle = (distinctive || item).toLowerCase();
    if (!reportLower.includes(needle)) missingItems.push(item);
  }
  return {
    passed: hasEvidenceBlock && missingItems.length === 0,
    missingItems,
    hasEvidenceBlock,
  };
}
