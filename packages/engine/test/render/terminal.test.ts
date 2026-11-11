import { describe, expect, it } from 'vitest';
import { candidate, minimalDocument, type Finding, type ReviewDocument } from '@airlock/shared';
import { renderReview } from '../../src/render/terminal.js';

function finding(over: Partial<Finding> = {}): Finding {
  return {
    ...candidate(),
    anchor: { status: 'in-diff', startLine: 12, endLine: 12 },
    fingerprint: 'fp1', checked: '', bucket: 'top', rank: 1, status: null,
    ...over,
  };
}

function fullDocument(): ReviewDocument {
  const doc = minimalDocument();
  doc.packs = [{ id: 'core', version: 'abcdef0123456789' }];
  doc.verdict = {
    label: 'request-changes', sentence: 'One problem must be fixed before this merges.',
    counts: { block: 1, fix: 2, ask: 1, note: 1 },
  };
  doc.brief = {
    whatItDoes: ['Adds a total to the cart.'],
    claims: [
      { text: 'Rounds to cents', verdict: 'not-supported', evidence: 'no rounding in total.ts' },
      { text: 'Handles empty carts', verdict: 'unclear', evidence: 'no test' },
      { text: 'Adds a field', verdict: 'verified', evidence: 'seen in diff' },
    ],
  };
  doc.findings = [
    finding({
      severity: 'block', title: 'Total is not rounded', checked: 'Searched callers for rounding.',
      connected: [
        { path: 'src/cart.ts', line: 40, role: 'caller', quote: 'total()' },
        { path: 'src/pay.ts', line: null, role: 'consumer', quote: 'x' },
      ],
      source: { pack: 'core', lens: 'correctness', ruleId: null },
    }),
    finding({
      id: 'c2', severity: 'fix', title: 'Missing test', bucket: 'also', rank: null,
      anchor: { status: 'in-diff', startLine: 3, endLine: 3 }, source: { pack: 'core', lens: null, ruleId: 'tests-1' },
    }),
  ];
  doc.questions = [{ text: 'Is the cap intended?', cohortId: null, source: { pack: 'core', lens: 'x', ruleId: null } }];
  doc.whoseCall = ['Product decides the rounding mode.'];
  doc.checksAfterMerge = ['Check totals on staging.'];
  doc.files = [{ path: 'src/total.ts', tier: 'read', reason: 'logic' }];
  doc.map = {
    cohorts: [{
      id: 'k1', title: 'Totals', summary: 's', neighbours: [], inferredLinks: [],
      layers: [{ id: 'l1', title: 'Rules', kind: 'rules', files: ['src/total.ts'], dependsOn: [], note: '' }],
    }],
    standalone: ['README.md'], links: [],
  };
  const c = candidate();
  doc.dropped = [{ candidate: { ...c, title: 'Naming nit' }, stage: 'challenge', reason: 'pre-existing', refutation: null }];
  doc.timings = [
    { stage: 'brief', ms: 1234, agentRuns: 1, inputTokens: 12000, outputTokens: 3400, costUsd: null },
    { stage: 'lenses', ms: 20000, agentRuns: 4, inputTokens: 100000, outputTokens: 6600, costUsd: null },
  ];
  return doc;
}

describe('renderReview', () => {
  it('prints the verdict first and the severity word in brackets', () => {
    const out = renderReview(fullDocument());
    const lines = out.split('\n');
    const v = lines.findIndex((l) => l === 'Request changes');
    expect(v).toBeGreaterThan(0);
    expect(lines.slice(0, v).join('\n')).not.toContain('Findings');
    expect(lines[v + 1]).toBe('One problem must be fixed before this merges.');
    expect(lines[v + 2]).toBe('1 Block, 2 Fix, 1 Ask, 1 Note');
    expect(out).toContain('1. [Block] Total is not rounded');
  });

  it('prints connected places under Also involves with their roles', () => {
    const out = renderReview(fullDocument());
    expect(out).toContain('   Also involves:\n     src/cart.ts:40  caller\n     src/pay.ts:?  consumer');
  });

  it('says outside the diff when the anchor is outside-diff', () => {
    const doc = fullDocument();
    doc.findings[0]!.anchor = { status: 'outside-diff', startLine: 7, endLine: 7 };
    expect(renderReview(doc)).toContain('   src/total.ts:7, outside the diff');
  });

  it('prints stage errors when the verdict is incomplete', () => {
    const doc = minimalDocument();
    doc.verdict = { label: 'incomplete', sentence: 'A stage failed.', counts: { block: 0, fix: 0, ask: 0, note: 0 } };
    doc.stageErrors = [{ stage: 'lenses', cohortId: 'k1', message: 'timed out' }, { stage: 'brief', cohortId: null, message: 'bad json' }];
    const out = renderReview(doc);
    expect(out).toContain('Incomplete');
    expect(out).toContain('Stage errors\n\n- lenses, cohort k1: timed out\n- brief: bad json');
  });

  it('uses the verdict words for every label', () => {
    const words = {
      'not-ready': 'Not ready', 'ready-for-pr2': 'Ready for PR #2', 'split-first': 'Split first',
      'request-changes': 'Request changes', 'approve-after-fixes': 'Approve after fixes', approve: 'Approve',
      incomplete: 'Incomplete',
    } as const;
    for (const [label, word] of Object.entries(words)) {
      const doc = minimalDocument();
      doc.verdict.label = label as keyof typeof words;
      expect(renderReview(doc).split('\n')).toContain(word);
    }
  });

  it('has no escape characters without colour, and colours only the verdict and severity words with it', () => {
    expect(renderReview(fullDocument())).not.toContain('\u001b');
    expect(renderReview(fullDocument(), { color: false })).not.toContain('\u001b');
    const coloured = renderReview(fullDocument(), { color: true });
    const stripped = coloured.replace(/\u001b\[[0-9;]*m/g, '');
    expect(stripped).toBe(renderReview(fullDocument()));
    expect(coloured).toMatch(/\u001b\[[0-9;]*mRequest changes\u001b\[0m/);
    expect(coloured).toMatch(/\[\u001b\[[0-9;]*mBlock\u001b\[0m\]/);
  });

  it('leaves out a section with nothing to show', () => {
    const out = renderReview(minimalDocument());
    for (const h of ['What this does', 'Claims', 'Findings', 'Also found', 'Questions', 'Whose call', 'Check after merge',
      'Change map', 'Dropped', 'Stage errors', 'Timing']) {
      expect(out).not.toContain(h);
    }
    const doc = fullDocument();
    doc.brief.claims = [{ text: 'ok', verdict: 'verified', evidence: 'e' }];
    expect(renderReview(doc)).not.toContain('Claims');
  });

  it('prints the header with repo, number, title, stage, depth, short sha and packs', () => {
    const lines = renderReview(fullDocument()).split('\n');
    expect(lines[0]).toBe('acme/widgets #1  Add totals');
    expect(lines[1]).toBe('PR #1 (fork to org branch) · standard · reviewed bbbbbbb · packs: core@abcdef0');
  });

  it('words the stage, and says nothing for other', () => {
    const cases = { pr1: 'PR #1 (fork to org branch)', pr2: 'PR #2 (into staging)', pr3: 'PR #3 (release)' } as const;
    for (const [stage, words] of Object.entries(cases)) {
      const doc = minimalDocument();
      doc.pr.stage = stage as keyof typeof cases;
      expect(renderReview(doc).split('\n')[1]).toMatch(new RegExp(`^${words.replace(/[()#]/g, '\\$&')} · `));
    }
    const doc = minimalDocument();
    doc.pr.stage = 'other';
    expect(renderReview(doc).split('\n')[1]).toBe('standard · reviewed bbbbbbb · packs: none');
  });

  it('leaves zero counts out of the counts line', () => {
    const doc = minimalDocument();
    doc.verdict.counts = { block: 0, fix: 3, ask: 0, note: 1 };
    expect(renderReview(doc)).toContain('\n3 Fix, 1 Note\n');
  });

  it('wraps a long Happens at 100 with a hanging indent', () => {
    const doc = fullDocument();
    doc.findings[0]!.happens = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
    const lines = renderReview(doc).split('\n');
    const i = lines.findIndex((l) => l.startsWith('   Happens: '));
    expect(lines[i + 1]!.startsWith('            word')).toBe(true);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(100);
    expect(lines.slice(i, i + 4).join(' ').replace(/\s+/g, ' ')).toContain('word0 word1');
  });

  it('never wraps a long path', () => {
    const doc = fullDocument();
    const long = `src/${'deep/'.repeat(30)}file.ts`;
    doc.findings[0]!.path = long;
    expect(renderReview(doc)).toContain(`   ${long}:12\n`);
  });

  it('shows the status after the title, and Why, Change, Checked and From lines', () => {
    const doc = fullDocument();
    doc.findings[0]!.status = 'fixed';
    const out = renderReview(doc);
    expect(out).toContain('1. [Block] Total is not rounded (Fixed)');
    expect(out).toContain('   Why: Customers see');
    expect(out).toContain('   Change: Round to cents before returning.');
    expect(out).toContain('   Checked: Searched callers for rounding.');
    expect(out).toContain('   From: core · correctness');
    doc.findings[0]!.suggestedChange = '';
    doc.findings[0]!.checked = '';
    expect(renderReview(doc)).not.toMatch(/Change:|Checked:/);
  });

  it('prints the other sections in order', () => {
    const out = renderReview(fullDocument());
    const order = ['What this does', 'Claims', 'Findings', 'Also found', 'Questions', 'Whose call', 'Check after merge',
      'Change map', 'Dropped: 1', 'Stage errors'].filter((h) => out.includes(`\n${h}\n`));
    const positions = order.map((h) => out.indexOf(`\n${h}\n`));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(out).toContain('- Not supported: Rounds to cents (no rounding in total.ts)');
    expect(out).toContain('- Unclear: Handles empty carts (no test)');
    expect(out).not.toContain('Adds a field');
    expect(out).toContain('- [Fix] Missing test  (src/total.ts:3)');
    expect(out).toContain('- Is the cap intended?');
    expect(out).toContain('- Product decides the rounding mode.');
    expect(out).toContain('1. Check totals on staging.');
    expect(out).toContain('Totals\n  1. Rules [rules]\n     src/total.ts  (read)\nStandalone:\n     README.md');
    expect(out).toContain('- Naming nit (challenge: pre-existing)');
    expect(out).toContain('Also found\n\n');
  });

  it('shows 5 files per layer and a count of the rest past 40 files', () => {
    const doc = minimalDocument();
    const files = Array.from({ length: 41 }, (_, i) => `src/f${i}.ts`);
    doc.map = {
      cohorts: [{
        id: 'k', title: 'Big', summary: '', neighbours: [], inferredLinks: [],
        layers: [{ id: 'l', title: 'All', kind: 'other', files, dependsOn: [], note: '' }],
      }],
      standalone: [], links: [],
    };
    const out = renderReview(doc);
    expect(out).toContain('     src/f4.ts  (?)\n     … 36 more');
    expect(out).not.toContain('src/f5.ts');
    doc.map.cohorts[0]!.layers[0]!.files = files.slice(0, 40);
    expect(renderReview(doc)).toContain('src/f39.ts');
  });

  it('prints a timing table with a total row, and cost only when a stage has one', () => {
    const doc = fullDocument();
    const out = renderReview(doc);
    expect(out.trimEnd().split('\n').at(-1)).toMatch(/^total\s+21\.2\s+5\s+112,000\s+10,000$/);
    expect(out).toMatch(/\nbrief\s+1\.2\s+1\s+12,000\s+3,400\n/);
    expect(out).not.toContain('Cost');
    doc.timings[0]!.costUsd = 0.5;
    const withCost = renderReview(doc);
    expect(withCost).toContain('Cost');
    expect(withCost.trimEnd().split('\n').at(-1)).toMatch(/0\.50$/);
  });

  it('shows 5 files of a long standalone list past 40 files in total', () => {
    const doc = minimalDocument();
    doc.map = { cohorts: [], standalone: Array.from({ length: 45 }, (_, i) => `docs/d${i}.md`), links: [] };
    const out = renderReview(doc);
    expect(out).toContain('Standalone:\n     docs/d0.md\n     docs/d1.md\n     docs/d2.md\n     docs/d3.md\n     docs/d4.md\n     … 40 more');
    expect(out).not.toContain('docs/d5.md');
  });

  describe('control characters', () => {
    const evil = '\u001b[31m\u001b]0;x\u0007\r\n\u2028\u2029\u007f\u0085';
    const dirty = (clean: string) => `${clean}${evil}${clean}`;
    function build(wrapIn: (s: string) => string): ReviewDocument {
      const doc = fullDocument();
      doc.pr.title = wrapIn('Title');
      doc.findings[0]!.title = wrapIn('Finding');
      doc.findings[0]!.path = wrapIn('src/a.ts');
      doc.findings[0]!.happens = wrapIn('happens');
      doc.findings[0]!.connected[0]!.role = wrapIn('caller');
      doc.stageErrors = [{ stage: 'lenses', cohortId: null, message: wrapIn('boom') }];
      doc.map.cohorts[0]!.title = wrapIn('Cohort');
      doc.dropped[0]!.reason = wrapIn('reason');
      doc.packs = [{ id: wrapIn('core'), version: 'abcdef0123' }];
      return doc;
    }
    const plain = renderReview(build((s) => `${s}${s}`));

    it('leaves no control characters and forges no lines without colour', () => {
      const out = renderReview(build(dirty), { color: false });
      for (const bad of ['\u001b', '\u0007', '\r', '\u2028', '\u2029', '\u007f', '\u0085']) expect(out).not.toContain(bad);
      expect(out.split('\n').length).toBe(plain.split('\n').length);
    });

    it('leaves only our own colour sequences with colour', () => {
      const out = renderReview(build(dirty), { color: true });
      expect(out.replace(/\u001b\[[0-9;]*m/g, '')).not.toContain('\u001b');
      expect(out.split('\n').length).toBe(plain.split('\n').length);
    });
  });

  describe('proof under a dropped item', () => {
    const withRefutation = (refutation: { path: string; line: number | null; role: string; quote: string } | null): ReviewDocument => {
      const doc = fullDocument();
      doc.dropped = [{ candidate: { ...candidate(), title: 'Naming nit' }, stage: 'challenge', reason: 'refuted', refutation }];
      return doc;
    };
    const droppedLines = (out: string): string[] => {
      const lines = out.split('\n');
      const i = lines.findIndex((l) => l.startsWith('Dropped:'));
      return lines.slice(i + 2, lines.findIndex((l, j) => j > i + 2 && l === ''));
    };

    it('prints the proof under a dropped item that has a refutation', () => {
      const out = renderReview(withRefutation({ path: 'src/a.ts', line: 7, role: 'head', quote: 'return 1;' }));
      expect(droppedLines(out)).toEqual(['- Naming nit (challenge: refuted)', '  proof: src/a.ts:7 (head) "return 1;"']);
    });

    it('prints no proof line when the refutation is null', () => {
      expect(droppedLines(renderReview(withRefutation(null)))).toEqual(['- Naming nit (challenge: refuted)']);
    });

    it('omits the line number when the refutation has none', () => {
      const out = renderReview(withRefutation({ path: 'src/a.ts', line: null, role: 'base', quote: 'x' }));
      expect(out).toContain('  proof: src/a.ts (base) "x"');
    });

    it('cuts a long code quote but prints a recorded decision in full', () => {
      const long = 'word '.repeat(60).trim();
      const code = renderReview(withRefutation({ path: 'a.ts', line: 1, role: 'head', quote: long }));
      expect(code).toContain(`"${long.slice(0, 160)}…"`);
      expect(code).not.toContain(long);
      const record = renderReview(withRefutation({ path: 'log.md', line: 2, role: 'standard', quote: long }));
      const proof = droppedLines(record).slice(1);
      expect(proof.length).toBeGreaterThan(1);
      expect(proof.every((l) => l.length <= 100)).toBe(true);
      expect(proof.join(' ').replace(/\s+/g, ' ')).toContain(`"${long}"`);
    });

    it('cleans control characters out of the proof line', () => {
      const out = renderReview(withRefutation({ path: 'a\u001b[31m.ts', line: 1, role: 'he\u0007ad', quote: 'x\r\ny\u2028z' }));
      expect(out).toContain('  proof: a[31m.ts:1 (head) "x yz"');
      for (const bad of ['\u001b', '\u0007', '\r', '\u2028']) expect(out).not.toContain(bad);
    });
  });
});
