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
    .filter((l) => l.length > 0)
    // Boundary lines ("Out of scope: ...") constrain the auditor's judgment;
    // they are not deliverables and have no evidence to quote (v0.22.6).
    .filter((l) => !/^out of scope\b/i.test(l));
}

export interface RegressionShieldResult {
  passed: boolean;
  missingItems: string[];
  hasEvidenceBlock: boolean;
}

/** Strip prose punctuation glued to a token ("file/element." → "file/element"). */
function stripEdgePunct(w: string): string {
  return w.replace(/^[^A-Za-z0-9]+/, "").replace(/[^A-Za-z0-9/_.-]+$/, "");
}

/**
 * Is a candidate token present in the report? Compound tokens joined by
 * "-" or "/" (left-cropped, file/element, Phaser/Svelte) count as present
 * when ALL their segments (len >= 3) appear — a good-faith report writes
 * "no cropped strip on the left", not the contract's literal compound.
 */
function tokenPresent(candidate: string, reportLower: string): boolean {
  const c = candidate.toLowerCase();
  if (reportLower.includes(c)) return true;
  const segments = c.split(/[-/]+/).filter((s) => s.length >= 3);
  return segments.length > 1 && segments.every((s) => reportLower.includes(s));
}

/**
 * Check an approved auditor report against the verification contract.
 * Rules (deliberately simple + auditable):
 *   1. The report must contain an <evidence> ... </evidence> block.
 *   2. Every contract item must be referenced inside the report by ANY of
 *      its top-3 longest tokens (>= 5 chars, edge punctuation stripped;
 *      compounds match via their segments). v0.22.6: the previous
 *      single-longest-word rule false-rejected genuine approvals when the
 *      longest word was contract-only vocabulary ("left-cropped") or had
 *      prose punctuation glued on ("file/element.") — three real approved
 *      audits on hegemon were converted to disapprovals that way.
 */
export function checkRegressionShield(report: string, contract: string): RegressionShieldResult {
  const hasEvidenceBlock = /<evidence>[\t\n\r ]*[\s\S]*?<\/evidence>/i.test(report);
  const items = contractItems(contract);
  const missingItems: string[] = [];
  const reportLower = report.toLowerCase();
  for (const item of items) {
    const candidates = item
      .split(/[^A-Za-z0-9_.\-/]+/)
      .map(stripEdgePunct)
      .filter((w) => w.length >= 5)
      .sort((a, b) => b.length - a.length)
      .slice(0, 3);
    const addressed = candidates.length > 0
      ? candidates.some((c) => tokenPresent(c, reportLower))
      : reportLower.includes(item.toLowerCase());
    if (!addressed) missingItems.push(item);
  }
  return {
    passed: hasEvidenceBlock && missingItems.length === 0,
    missingItems,
    hasEvidenceBlock,
  };
}
