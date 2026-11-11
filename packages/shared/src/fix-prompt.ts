import type { Finding, ReviewDocument, Severity } from './review.js';

const SEVERITY_WORD: Record<Severity, string> = { block: 'Block', fix: 'Fix', ask: 'Ask', note: 'Note' };

function locationOf(finding: Finding): string {
  const { status, startLine } = finding.anchor;
  const where = startLine === null ? finding.path : `${finding.path}:${startLine}`;
  if (status === 'outside-diff') return `${where} (outside the changed lines)`;
  if (status === 'not-found') return finding.path;
  return where;
}

function fenced(quote: string): string {
  const longest = Math.max(0, ...(quote.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}\n${quote}\n${fence}`;
}

function block(finding: Finding, index: number): string {
  const lines = [
    `${index + 1}. ${finding.title}`,
    `   Severity: ${SEVERITY_WORD[finding.severity]}`,
    `   Where: ${locationOf(finding)}`,
    '',
    fenced(finding.quote),
    '',
    `What happens: ${finding.happens}`,
    `Why: ${finding.why}`,
    `Suggested change: ${finding.suggestedChange}`,
  ];
  if (finding.connected.length > 0) {
    lines.push('Also involves:');
    for (const place of finding.connected) {
      const at = place.line === null ? place.path : `${place.path}:${place.line}`;
      lines.push(`- ${at} (${place.role})`);
    }
  }
  if (finding.wouldBeWrongIf.trim() !== '') lines.push(`Check first: ${finding.wouldBeWrongIf}`);
  return lines.join('\n');
}

const CLOSING = [
  'Fix each at its cause. Keep each change small. Add or update a test that would have caught it. Change nothing unrelated.',
  'If an item turns out to be wrong, say why instead of changing code.',
  'Finish with one line per item saying what was changed.',
].join('\n');

/** Plain text for a coding agent working in a checkout of the pull request's branch. */
export function fixPrompt(doc: ReviewDocument, findings: Finding[]): string {
  const { repo, number, title, headRef } = doc.pr;
  const opening =
    `You are working in a checkout of the branch ${headRef} of ${repo}, pull request #${number} "${title}". ` +
    'These problems were found in review.';
  if (findings.length === 0) return `${opening}\n\nNo findings were selected, so there is nothing to change.\n`;
  return `${[opening, ...findings.map(block), CLOSING].join('\n\n')}\n`;
}
