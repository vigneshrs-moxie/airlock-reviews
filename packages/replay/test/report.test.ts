import type { ReviewDocument } from '@airlock/shared';
import { describe, expect, it } from 'vitest';
import { renderReport, scoreCase, summarise } from '../src/index.js';
import type { Match, ReplayCase } from '../src/index.js';
import { doc, dropped, finding, problem, raw, replayCase } from './fixtures.js';

const match = (knownId: string, where: Match['where'], itemId: string | null, reason = `Judge reason for ${knownId}.`, partial = false): Match =>
  ({ knownId, where, itemId, partial, reason });

const timing = (ms: number, inputTokens: number, outputTokens: number, agentRuns: number) =>
  ({ stage: 'lenses', ms, agentRuns, inputTokens, outputTokens, costUsd: null });

function scenario() {
  const positive = replayCase({
    id: 'pr100', pr: 100, title: 'Announcements', lines: 579,
    known: [
      problem({ id: 'C2', summary: 'Claimed rows are never re-queued.' }),
      problem({ id: 'C3', summary: 'The PATCH route has no time limit.' }),
      problem({ id: 'C4', summary: 'The cron is not registered.' }),
      problem({ id: 'C5', summary: 'Nobody reads the audit table.' }),
      problem({ id: 'C6', summary: 'The preview ignores drafts.' }),
      problem({ id: 'C7', summary: 'The seed skips one office.' }),
      problem({ id: 'C8', summary: 'The key can collide.' }),
      problem({ id: 'C9', summary: 'The schema answer was malformed.' }),
    ],
  });
  const positiveDoc = doc({
    findings: [finding('f1', 'top', { title: 'Rows stay claimed' }), finding('f2', 'also', { title: 'Preview skips drafts' })],
    dropped: [
      dropped('d1', 'challenge', 'Guarded by the confirm route.'),
      dropped('d2', 'anchor', 'Quote not found.'),
      dropped('d3', 'schema', 'Missing field.'),
    ],
    candidates: [raw('c8', { title: 'Key collision' })],
    questions: [{ text: 'Who reads the audit table?', cohortId: null, source: { pack: 'core', lens: null, ruleId: null } }],
    verdict: { label: 'request-changes', sentence: 's', counts: { block: 1, fix: 0, ask: 0, note: 0 } },
    timings: [timing(125_000, 120_000, 8_000, 9)],
  });
  const positiveMatches = [
    match('C2', 'top', 'f1', 'Same claimed-row cause.', true),
    match('C3', 'dropped', 'd1'),
    match('C4', 'none', null, 'Nothing about the cron.'),
    match('C5', 'question', 'q1'),
    match('C6', 'also', 'f2'),
    match('C7', 'dropped', 'd2'),
    match('C8', 'candidate', 'c8'),
    match('C9', 'dropped', 'd3'),
  ];

  const negative = replayCase({ id: 'pr200', pr: 200, title: 'Tidy | the\nlist', lines: 40, kind: 'negative', known: [] });
  const negativeDoc = doc({
    findings: [
      finding('n1', 'top', {
        severity: 'block', title: 'Title with | pipe\nand newline', path: 'src/a|b.ts',
        anchor: { status: 'in-diff', startLine: 7, endLine: 9 },
        happens: 'The list | breaks\n- here', why: 'Because\n\n# heading',
      }),
      finding('n2', 'also', { severity: 'note', title: 'Name could be clearer', path: 'src/name.ts', lineHint: 3,
        anchor: { status: 'not-found', startLine: null, endLine: null }, happens: 'It reads oddly.', why: 'Readers trip.' }),
    ],
    timings: [timing(60_000, 50_000, 2_000, 5)],
  });

  const clean = replayCase({ id: 'pr201', pr: 201, title: 'Bump deps', lines: 10, kind: 'negative', known: [] });
  const cleanDoc = doc({
    verdict: { label: 'incomplete', sentence: 's', counts: { block: 0, fix: 0, ask: 0, note: 0 } },
    stageErrors: [{ stage: 'lenses', cohortId: 'c1', message: 'The lens\ntimed out' }],
    timings: [timing(1_000, 100, 10, 1)],
  });

  const cases: ReplayCase[] = [positive, negative, clean];
  const details: Record<string, { doc: ReviewDocument; matches: Match[] }> = {
    pr100: { doc: positiveDoc, matches: positiveMatches },
    pr200: { doc: negativeDoc, matches: [] },
    pr201: { doc: cleanDoc, matches: [] },
  };
  const scores = cases.map((c) => scoreCase(c, details[c.id]!.doc, details[c.id]!.matches));
  const summary = summarise('2026-11-11T09-00', 'claude-opus-5-5', 'standard', scores, cases);
  return { cases, details, summary, text: renderReport(summary, cases, details) };
}

/** The lines of the section whose heading starts with `heading`, up to the next heading of the same level. */
function section(text: string, heading: string): string {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`## ${heading}`));
  if (start === -1) throw new Error(`no section ${heading}`);
  const end = lines.findIndex((l, i) => i > start && l.startsWith('## '));
  return lines.slice(start, end === -1 ? undefined : end).join('\n');
}

const unescapedPipes = (line: string): number => (line.match(/(?<!\\)\|/g) ?? []).length;

describe('renderReport', () => {
  it('opens with the run id, model and depth', () => {
    const { text } = scenario();
    const head = text.split('\n').slice(0, 4).join('\n');
    expect(head).toMatch(/^# .*2026-11-11T09-00/);
    expect(head).toContain('claude-opus-5-5');
    expect(head).toContain('standard');
  });

  it('states the two tests with their numbers and a plain answer', () => {
    const { text } = scenario();
    const tests = section(text, 'The two tests');
    expect(tests).toContain('1 of 8');
    expect(tests).toMatch(/\bNo\b/);
    expect(tests).toContain('This needs your look: 1 clean pull request was given a Block or Fix; it is listed below.');
    // pr201's review failed, so it is not counted as clean either.
    expect(tests).toContain('The review of 1 clean pull request did not finish (#201 Bump deps), so it cannot be counted as clean.');
  });

  it('uses the plural when several clean pull requests were given a Block or Fix', () => {
    const negatives = ['n1', 'n2'].map((id, i) => replayCase({ id, pr: 300 + i, kind: 'negative', known: [] }));
    const d = doc({ findings: [finding('f1', 'top', { severity: 'fix' })] });
    const details = { n1: { doc: d, matches: [] }, n2: { doc: d, matches: [] } };
    const summary = summarise('r', 'm', 'standard', negatives.map((c) => scoreCase(c, d, [])), negatives);
    const tests = section(renderReport(summary, negatives, details), 'The two tests');
    expect(tests).toContain('This needs your look: 2 clean pull requests were given a Block or Fix; they are listed below.');
  });

  it('answers yes to both tests when they are met', () => {
    const c = replayCase({ known: [problem({ id: 'K1' })] });
    const n = replayCase({ id: 'n1', pr: 2, kind: 'negative', known: [] });
    const d = doc({ findings: [finding('f1', 'top')] });
    const details = { pr1: { doc: d, matches: [match('K1', 'top', 'f1')] }, n1: { doc: doc(), matches: [] } };
    const scores = [scoreCase(c, d, details.pr1.matches), scoreCase(n, details.n1.doc, [])];
    const tests = section(renderReport(summarise('r', 'm', 'standard', scores, [c, n]), [c, n], details), 'The two tests');
    expect(tests.match(/\bYes\b/g)).toHaveLength(2);
    expect(tests).not.toContain('needs your look');
    expect(tests).not.toContain('Not tested');
  });

  it('says a test was not run when there are no clean pull requests', () => {
    const c = replayCase({ known: [problem({ id: 'K1' })] });
    const d = doc({ findings: [finding('f1', 'top')] });
    const details = { pr1: { doc: d, matches: [match('K1', 'top', 'f1')] } };
    const summary = summarise('r', 'm', 'standard', [scoreCase(c, d, details.pr1.matches)], [c]);
    const lines = section(renderReport(summary, [c], details), 'The two tests').split('\n');
    const second = lines.find((l) => l.startsWith('2. '))!;
    expect(second).toContain('Not tested in this run');
    expect(second).not.toMatch(/\bYes\b/);
  });

  it('says a test was not run when there are no pull requests with known problems', () => {
    const n = replayCase({ id: 'n1', kind: 'negative', known: [] });
    const details = { n1: { doc: doc(), matches: [] } };
    const text = renderReport(summarise('r', 'm', 'standard', [scoreCase(n, details.n1.doc, [])], [n]), [n], details);
    const first = section(text, 'The two tests').split('\n').find((l) => l.startsWith('1. '))!;
    expect(first).toContain('Not tested in this run');
    expect(first).not.toMatch(/\b(Yes|No)\b/);
    const missed = section(text, 'What was missed');
    expect(missed).toContain('There were no pull requests with known problems in this run.');
    expect(missed).not.toContain('Every known problem was in the top five');
    const table = section(text, 'Each pull request');
    expect(table).toContain('There were no pull requests with known problems in this run.');
    expect(table).not.toContain('| Pull request |');
  });

  it('a positive review that did not finish keeps its problems as missed and is named under the first test', () => {
    const done = replayCase({ id: 'a', pr: 10, title: 'Done', known: [problem({ id: 'A1' })] });
    const failed = replayCase({ id: 'b', pr: 11, title: 'Failed', known: [problem({ id: 'B1' }), problem({ id: 'B2' })] });
    const doneDoc = doc({ findings: [finding('f1', 'top')] });
    const failedDoc = doc({ verdict: { label: 'incomplete', sentence: 's', counts: { block: 0, fix: 0, ask: 0, note: 0 } } });
    const details = { a: { doc: doneDoc, matches: [match('A1', 'top', 'f1')] }, b: { doc: failedDoc, matches: [match('B1', 'none', null), match('B2', 'none', null)] } };
    const scores = [scoreCase(done, doneDoc, details.a.matches), scoreCase(failed, failedDoc, details.b.matches)];
    const summary = summarise('r', 'm', 'standard', scores, [done, failed]);
    expect(summary).toMatchObject({ knownTotal: 3, inTopTotal: 1, positivesIncomplete: 1 });
    const first = section(renderReport(summary, [done, failed], details), 'The two tests').split('\n').find((l) => l.startsWith('1. '))!;
    expect(first).toContain('1 of 3');
    expect(first).toContain('The review of 1 of these pull requests did not finish (#11 Failed); its known problems are counted as missed.');
  });

  it('a case the replay could not judge says so instead of listing its problems as never found', () => {
    const failed = replayCase({ id: 'b', pr: 11, title: 'Failed', known: [problem({ id: 'B1' }), problem({ id: 'B2' })] });
    const clean = replayCase({ id: 'n', pr: 12, title: 'Clean', kind: 'negative', known: [] });
    const failedDoc = doc({ verdict: { label: 'incomplete', sentence: 's', counts: { block: 0, fix: 0, ask: 0, note: 0 } } });
    const none = [match('B1', 'none', null, 'Not judged.'), match('B2', 'none', null, 'Not judged.')];
    // How the runner scores a case it could not judge: incomplete, and not lost at any stage.
    const lostAt = { lenses: 0, schema: 0, anchor: 0, merge: 0, challenge: 0, select: 0 };
    const scores = [{ ...scoreCase(failed, failedDoc, none), lostAt }, scoreCase(clean, failedDoc, [])];
    const details = { b: { doc: failedDoc, matches: none }, n: { doc: failedDoc, matches: [] } };
    const text = renderReport(summarise('r', 'm', 'standard', scores, [failed, clean]), [failed, clean], details);

    const missed = section(text, 'What was missed');
    expect(missed).toContain('### #11 Failed\n\nNot judged: this review did not finish; see Incomplete reviews.\n');
    expect(missed).not.toContain('never found by a lens');
    expect(missed).not.toContain('B1');
    const findings = section(text, 'Findings on clean pull requests');
    expect(findings).toContain('### #12 Clean\n\nNot judged: this review did not finish; see Incomplete reviews.\n');
    expect(findings).not.toContain('No findings shown.');
  });

  it('a review that finished with a failed stage but was judged still lists its misses, and a clean one its findings', () => {
    const c = replayCase({ id: 'b', pr: 11, title: 'Partly', known: [problem({ id: 'B1' })] });
    const n = replayCase({ id: 'n', pr: 12, title: 'Flagged', kind: 'negative', known: [] });
    const incomplete = { label: 'incomplete', sentence: 's', counts: { block: 0, fix: 1, ask: 0, note: 0 } } as const;
    const d = doc({ verdict: incomplete });
    const flagged = doc({ verdict: incomplete, findings: [finding('f1', 'top', { severity: 'fix', title: 'Wrong total' })] });
    const details = { b: { doc: d, matches: [match('B1', 'none', null)] }, n: { doc: flagged, matches: [] } };
    const scores = [scoreCase(c, d, details.b.matches), scoreCase(n, flagged, [])];
    const text = renderReport(summarise('r', 'm', 'standard', scores, [c, n]), [c, n], details);
    expect(section(text, 'What was missed')).toContain('never found by a lens');
    const findings = section(text, 'Findings on clean pull requests');
    expect(findings).toContain('Not judged: this review did not finish; see Incomplete reviews.');
    expect(findings).toContain('**Fix**: Wrong total');
  });

  it('says clean reviews that did not finish cannot be counted as clean', () => {
    const n1 = replayCase({ id: 'n1', pr: 5, title: 'Fine', kind: 'negative', known: [] });
    const n2 = replayCase({ id: 'n2', pr: 6, title: 'Broke', kind: 'negative', known: [] });
    const broke = doc({ verdict: { label: 'incomplete', sentence: 's', counts: { block: 0, fix: 0, ask: 0, note: 0 } } });
    const details = { n1: { doc: doc(), matches: [] }, n2: { doc: broke, matches: [] } };
    const summary = summarise('r', 'm', 'standard', [scoreCase(n1, details.n1.doc, []), scoreCase(n2, broke, [])], [n1, n2]);
    expect(summary.meets.cleanControls).toBe('incomplete');
    const second = section(renderReport(summary, [n1, n2], details), 'The two tests').split('\n').find((l) => l.startsWith('2. '))!;
    expect(second).toContain('The review of 1 clean pull request did not finish (#6 Broke), so it cannot be counted as clean. ' +
      'This test has no answer until it is run again.');
    expect(second).not.toMatch(/\bYes\b/);
  });

  describe('coverage of the dataset and secondary cases', () => {
    const positive = (n: number, known: number) =>
      replayCase({ id: `pr${n}`, pr: n, title: `Case ${n}`, known: Array.from({ length: known }, (_, i) => problem({ id: `P${n}-${i}` })) });
    const dataset = [positive(100, 5), positive(171, 9), positive(126, 2), positive(129, 3), positive(143, 4), positive(146, 3)];
    const secondary = replayCase({ id: 'pr220', pr: 220, title: 'Fixes described in the body', kind: 'secondary', known: [problem({ id: 'S1', summary: 'The secondary problem.' })] });

    function render(run: ReplayCase[], inTop: Record<string, number>, all: ReplayCase[] = dataset) {
      const details: Record<string, { doc: ReviewDocument; matches: Match[] }> = {};
      for (const c of run) {
        const d = doc({ findings: [finding('f1', 'top')] });
        details[c.id] = { doc: d, matches: c.known.map((k, i) => (i < (inTop[c.id] ?? 0) ? match(k.id, 'top', 'f1') : match(k.id, 'none', null))) };
      }
      const scores = run.map((c) => scoreCase(c, details[c.id]!.doc, details[c.id]!.matches));
      const summary = summarise('r', 'm', 'standard', scores, run, all);
      return { summary, text: renderReport(summary, all, details) };
    }

    it('a partial run says so far, how much of the dataset it covers and which pull requests were not run', () => {
      const run = dataset.filter((c) => [129, 143, 146].includes(c.pr));
      const { text } = render(run, { pr129: 3, pr143: 3, pr146: 1 });
      const first = section(text, 'The two tests').split('\n').find((l) => l.startsWith('1. '))!;
      expect(first).toBe('1. At least half of the known problems should be in the top five. 7 of 10 were (70%). ' +
        "Yes so far: this run covers 10 of the dataset's 26 known problems; 3 pull requests were not run (#100, #126, #171).");
    });

    it('a run with every positive case answers Yes or No', () => {
      const { text } = render(dataset, { pr100: 5, pr171: 9 });
      const first = section(text, 'The two tests').split('\n').find((l) => l.startsWith('1. '))!;
      expect(first).toBe('1. At least half of the known problems should be in the top five. 14 of 26 were (54%). Yes.');
    });

    it('secondary cases have their own section and appear in no headline', () => {
      const run = [...dataset, secondary];
      const { text, summary } = render(run, { pr100: 5, pr171: 9, pr220: 1 }, run);
      expect(summary.knownTotal).toBe(26);
      const own = section(text, 'Secondary cases (not counted)');
      expect(own).toContain('| Pull request | Size (lines) | Known problems | In top five | Shown | Not shown |');
      expect(own).toMatch(/\| #220 Fixes described in the body \| 120 \| 1 \| 1 \| 1 \| 0 \|/);
      for (const heading of ['The two tests', 'Other numbers', 'Each pull request', 'What was missed']) {
        expect(section(text, heading), heading).not.toContain('#220');
      }
      expect(render(dataset, { pr100: 5, pr171: 9 }).text).not.toContain('Secondary cases');
    });
  });

  describe('the other items the judge named, and merges in words', () => {
    const c = replayCase({ id: 'a', pr: 10, title: 'Others', known: ['A1', 'A2', 'A3'].map((id) => problem({ id, summary: `Summary of ${id}.` })) });
    const d = doc({
      findings: [finding('f1', 'top', { title: 'Rows stay claimed' }), finding('f2', 'also', { title: 'Second look' })],
      dropped: [dropped('d1', 'challenge', 'Guarded.'), dropped('m1', 'merge', 'Merged with a finding that is gone.')],
      questions: [{ text: 'Who reads this?', cohortId: null, source: { pack: 'core', lens: null, ruleId: null } }],
      verdict: { label: 'incomplete', sentence: 's', counts: { block: 0, fix: 0, ask: 0, note: 0 } },
      stageErrors: [{ stage: 'merge', cohortId: null, message: 'The merge request failed.' }],
    });
    const matches: Match[] = [
      { ...match('A1', 'also', 'f2'), others: [{ itemId: 'q1', where: 'question', partial: false }, { itemId: 'd1', where: 'dropped', partial: true }] },
      { ...match('A2', 'dropped', 'm1'), others: [] },
      { ...match('A3', 'also', 'f2'), others: [{ itemId: 'd1', where: 'dropped', partial: false }] },
    ];
    const text = (): string => {
      const summary = summarise('r', 'm', 'standard', [scoreCase(c, d, matches)], [c]);
      return renderReport(summary, [c], { a: { doc: d, matches } });
    };

    it('lists the other items under each missed problem, with where each ended up', () => {
      const missed = section(text(), 'What was missed');
      expect(missed).toContain('  - The judge also named: q1, returned as a question; d1 (a partial match), dropped by the challenge.');
    });

    it('lists the other items under each shared problem', () => {
      const shared = section(text(), 'One finding matched to several known problems');
      expect(shared).toContain('- #10 Others: f2 (Second look) matched A1 and A3.');
      expect(shared).toContain('  - For A1 the judge also named: q1, returned as a question; d1 (a partial match), dropped by the challenge.');
      expect(shared).toContain('  - For A3 the judge also named: d1, dropped by the challenge.');
    });

    it('says merge in words wherever a stage is named', () => {
      const report = text();
      expect(section(report, 'What was missed')).toContain('It was found, then merged into another finding. Its reason: Merged with a finding that is gone.');
      expect(section(report, 'Incomplete reviews')).toContain('  - merged into another finding: The merge request failed.');
      expect(report).not.toMatch(/\bmerge:/);
    });

    it('a match saved without others reads as having none', () => {
      const old: Match[] = c.known.map((k) => match(k.id, 'none', null));
      const summary = summarise('r', 'm', 'standard', [scoreCase(c, doc(), old)], [c]);
      expect(section(renderReport(summary, [c], { a: { doc: doc(), matches: old } }), 'What was missed')).not.toContain('also named');
    });
  });

  it('lists a positive case with no details as details not available', () => {
    const c = replayCase({ id: 'a', pr: 10, title: 'Lost', known: [problem({ id: 'A1' })] });
    const summary = summarise('r', 'm', 'standard', [scoreCase(c, doc(), [])], [c]);
    const missed = section(renderReport(summary, [c], {}), 'What was missed');
    expect(missed).toContain('#10 Lost');
    expect(missed).toContain('Details not available.');
    expect(missed).not.toContain('Every known problem was in the top five');
  });

  it('lists one item matched to several known problems, and only when there is one', () => {
    const { text } = scenario();
    expect(text).not.toContain('## One finding matched to several known problems');
    const c = replayCase({ id: 'a', pr: 10, title: 'Shared', known: ['A1', 'A2', 'A3'].map((id) => problem({ id })) });
    const d = doc({ findings: [finding('f1', 'top', { title: 'Rows stay claimed' })] });
    const matches = [match('A1', 'top', 'f1'), match('A2', 'top', 'f1', 'r', true), match('A3', 'none', null)];
    const summary = summarise('r', 'm', 'standard', [scoreCase(c, d, matches)], [c]);
    expect(summary.sharedMatches).toBe(2);
    const report = renderReport(summary, [c], { a: { doc: d, matches } });
    const shared = section(report, 'One finding matched to several known problems');
    expect(shared).toContain('- #10 Shared: f1 (Rows stay claimed) matched A1 and A2.');
    expect(report.indexOf('## One finding matched')).toBeGreaterThan(report.indexOf('## Each pull request'));
    expect(report.indexOf('## One finding matched')).toBeLessThan(report.indexOf('## What was missed'));
  });

  it('neutralises Markdown in text from a review or the dataset', () => {
    const n = replayCase({ id: 'n1', pr: 7, title: 'Clean', kind: 'negative', known: [] });
    const d = doc({ findings: [finding('f1', 'top', { title: '![x](https://host/p)', happens: '**bold** _it_ `code` <b>tag</b> [link](u)' })] });
    const c = replayCase({ id: 'a', pr: 8, known: [problem({ id: 'C*1', summary: 'A *star* summary.' })] });
    const details = { n1: { doc: d, matches: [] }, a: { doc: doc(), matches: [match('C*1', 'none', null)] } };
    const summary = summarise('r', 'm', 'standard', [scoreCase(n, d, []), scoreCase(c, details.a.doc, details.a.matches)], [n, c]);
    const text = renderReport(summary, [n, c], details);
    expect(text).not.toContain('![x](');
    expect(text).toContain('\\!\\[x\\](https://host/p)');
    expect(text).toContain('\\*\\*bold\\*\\* \\_it\\_ \\`code\\` \\<b\\>tag\\</b\\> \\[link\\](u)');
    expect(text).toContain('- **C\\*1**: A \\*star\\* summary.');
  });

  it('gives the other numbers', () => {
    const { text } = scenario();
    const other = section(text, 'Other numbers');
    expect(other).toContain('2 of 8'); // shown: top plus also found
    expect(other).toContain('1 of 8 '); // real defects in the top five (all 8 are defects here)
    expect(other).toContain('Partial matches: 1 of the problems in the top five');
    expect(other).toContain('came back as a question instead of a finding: 1.');
    expect(other).toContain('Cross-file problems, which need a second file to see: 0 of 0 (0%)');
  });

  it('has a table row for each positive case', () => {
    const { text } = scenario();
    const table = section(text, 'Each pull request');
    expect(table).toContain('| Pull request | Size (lines) | Known problems | In top five | Shown | Not shown |');
    expect(table).toMatch(/\| #100 Announcements \| 579 \| 8 \| 1 \| 2 \| 6 \|/);
    expect(table).not.toContain('#200');
  });

  it('says where each missed problem was lost, with the judge reason', () => {
    const { text } = scenario();
    const missed = section(text, 'What was missed');
    expect(missed).not.toContain('C2');
    expect(missed).toMatch(/C3.*Claimed|C3.*PATCH/s);
    expect(missed).toContain('dropped by the challenge');
    expect(missed).toContain('Guarded by the confirm route.');
    expect(missed).toContain('never found by a lens');
    expect(missed).toContain('Nothing about the cron.');
    expect(missed).toContain('returned as a question');
    expect(missed).toContain('left out of the top five');
    expect(missed).toContain('the quoted code was not in the file');
    expect(missed).toContain('Judge reason for C9.');
    for (const id of ['C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9']) expect(missed).toContain(id);
  });

  it('the report lists every finding shown on a negative control', () => {
    const { text } = scenario();
    const clean = section(text, 'Findings on clean pull requests');
    expect(clean).toContain('Block');
    expect(clean).toContain('Title with \\| pipe and newline');
    expect(clean).toContain('src/a\\|b.ts:7');
    expect(clean).toContain('The list \\| breaks - here');
    expect(clean).toContain('Because # heading');
    expect(clean).toContain('Note');
    expect(clean).toContain('Name could be clearer');
    expect(clean).toContain('src/name.ts:3');
    expect(clean).toContain('It reads oddly.');
    expect(clean).toContain('Readers trip.');
    expect(clean.match(/\[ \] wrong {2}\[ \] right/g)).toHaveLength(2);
    expect(clean).toContain('#201');
  });

  it('a finding title containing | and a line break does not break the table or the list', () => {
    const { text } = scenario();
    const lines = text.split('\n');
    // No line starts with text that came from the second line of a field.
    for (const fragment of ['and newline', '- here', '# heading', 'list', 'timed out']) {
      expect(lines.some((l) => l.trimStart().startsWith(fragment))).toBe(false);
    }
    // Every table keeps the same number of cell borders on every row.
    let current: number | null = null;
    for (const line of lines) {
      if (!line.startsWith('|')) { current = null; continue; }
      const pipes = unescapedPipes(line);
      if (current === null) current = pipes;
      expect(pipes, line).toBe(current);
    }
    // The case title with a pipe sits in one cell of the time table.
    expect(text).toContain('#200 Tidy \\| the list');
  });

  it('lists incomplete reviews with their errors', () => {
    const { text } = scenario();
    const incomplete = section(text, 'Incomplete reviews');
    expect(incomplete).toContain('#201');
    expect(incomplete).toContain('The lens timed out');
  });

  it('leaves out the incomplete section when every review finished', () => {
    const c = replayCase({ known: [] , kind: 'negative' });
    const d = doc();
    const summary = summarise('r', 'm', 'standard', [scoreCase(c, d, [])], [c]);
    expect(renderReport(summary, [c], { pr1: { doc: d, matches: [] } })).not.toContain('## Incomplete reviews');
  });

  it('gives time and tokens per case and in total', () => {
    const { text } = scenario();
    const time = section(text, 'Time and tokens');
    // These reviews do not record their start, so each time is the sum of its stages: about.
    expect(time).toMatch(/\| #100 Announcements \| about 2 min 5 s \| 120,000 \| 8,000 \| 9 \|/);
    expect(time).toMatch(/\| Total \| about 3 min 6 s \| 170,100 \| 10,010 \| 15 \|/);
  });

  it('gives elapsed time for a review that records its start, and the time the run took as the total', () => {
    const c = replayCase({ id: 'a', pr: 10, title: 'Timed', known: [] , kind: 'negative' });
    const d = doc({ startedAt: '2026-11-10T09:00:00.000Z', createdAt: '2026-11-10T09:07:10.000Z', timings: [timing(900_000, 1, 1, 1)] });
    const spans = [{ startedAt: '2026-11-10T08:59:58.000Z', finishedAt: '2026-11-10T09:08:00.000Z' }];
    const summary = summarise('r', 'm', 'standard', [scoreCase(c, d, [])], [c], [c], { spans });
    const time = section(renderReport(summary, [c], { a: { doc: d, matches: [] } }), 'Time and tokens');
    expect(time).toMatch(/\| #10 Timed \| 7 min 10 s \|/);
    expect(time).toMatch(/\| Total \| 8 min 2 s \|/);
    expect(time).toContain('The total is the time from the first case\'s start to the last case\'s end');
    expect(time).not.toContain('runs of the command');
  });

  it('over several calls, the total is the time the replay was running and the note says over how many', () => {
    const c = replayCase({ id: 'a', pr: 10, title: 'Timed', known: [] , kind: 'negative' });
    const d = doc({ startedAt: '2026-11-10T09:00:00.000Z', createdAt: '2026-11-10T09:07:10.000Z', timings: [timing(900_000, 1, 1, 1)] });
    const spans = [
      { startedAt: '2026-11-10T09:00:00.000Z', finishedAt: '2026-11-10T09:08:00.000Z' },
      { startedAt: '2026-11-10T11:00:00.000Z', finishedAt: '2026-11-10T11:02:00.000Z' },
    ];
    const summary = summarise('r', 'm', 'standard', [scoreCase(c, d, [])], [c], [c], { spans });
    const time = section(renderReport(summary, [c], { a: { doc: d, matches: [] } }), 'Time and tokens');
    expect(time).toMatch(/\| Total \| 10 min 0 s \|/);
    expect(time).toContain('Total time is the time the replay was running, over 2 runs of the command.');
    expect(time).not.toContain('first case\'s start');
  });

  it('closes with how to read the numbers', () => {
    const { text } = scenario();
    const how = section(text, 'How to read this');
    expect(how).toContain('withheld');
    expect(how).toContain('rule sheet');
    expect(how).toContain('next pull requests');
    expect(how).toContain('title and description as they stood when the senior reviewer reviewed it');
    expect(how).not.toContain('earlier version');
  });

  it('a run folder made by an earlier version says so first under how to read this, and its first test is not comparable', () => {
    const { cases, details } = scenario();
    const scores = cases.map((c) => scoreCase(c, details[c.id]!.doc, details[c.id]!.matches));
    const summary = summarise('old-run', 'claude-opus-5-5', 'standard', scores, cases, cases, { madeByEarlierVersion: true });
    expect(summary.meets.halfInTop).toBe('not comparable');
    const text = renderReport(summary, cases, details);
    const how = section(text, 'How to read this').split('\n').filter((l) => l !== '');
    expect(how[1]).toBe(
      'The run folder old-run was made by an earlier version of the replay: its reviews read today\'s descriptions and its judge ' +
        'saw where each finding was placed, so these numbers cannot be compared with a run made today. ' +
        'When a pull request was replayed, the rules written from that pull request were withheld, so the review could not simply remember the answer. ' +
        "The team's rule sheet was written after these reviews and could not be withheld, so these numbers may be better than real use. " +
        'The true test is the next pull requests the senior reviewer comments on.',
    );
    expect(how.join('\n')).not.toContain('as they stood when the senior reviewer reviewed it');
    const first = section(text, 'The two tests').split('\n').find((l) => l.startsWith('1. '))!;
    expect(first).toBe('1. At least half of the known problems should be in the top five. 1 of 8 were (13%). Not comparable: see How to read this.');
  });
});
