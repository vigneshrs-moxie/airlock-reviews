import type { Finding, ReviewDocument } from '@airlock/shared';
import type { KnownProblem, ReplayCase } from './dataset.js';
import type { Match } from './judge.js';
import { sharedMatchItems } from './score.js';
import type { CaseScore, RunSummary } from './score.js';

type Details = Record<string, { doc: ReviewDocument; matches: Match[] }>;

/**
 * Makes text from a review or the dataset safe inside one Markdown line, list item or table cell:
 * line breaks become spaces, and the characters that make tables, emphasis, code, links, images
 * or HTML (`\ | * _ ` [ ] ! < >`) are backslash-escaped so they show as themselves.
 */
function md(text: string): string {
  return text
    .replace(/\s*[\r\n\u2028\u2029]+\s*/g, ' ')
    .replace(/\t/g, ' ')
    .trim()
    .replace(/[\\|*_`[\]!<>]/g, '\\$&');
}

const SEVERITY_WORD = { block: 'Block', fix: 'Fix', ask: 'Ask', note: 'Note' } as const;

const percent = (r: number): string => `${Math.round(r * 100)}%`;
const count = (n: number): string => n.toLocaleString('en-US');
const yesNo = (b: boolean): string => (b ? 'Yes' : 'No');
const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

/** "A", "A and B", "A, B and C". */
function andList(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

function duration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes} min ${seconds % 60} s` : `${seconds} s`;
}

function prName(c: ReplayCase | undefined, caseId: string): string {
  return c ? `#${c.pr} ${md(c.title)}` : md(caseId);
}

function table(header: string[], rows: string[][]): string[] {
  const line = (cells: string[]): string => `| ${cells.join(' | ')} |`;
  return [line(header), line(header.map(() => '---')), ...rows.map(line)];
}

/** Plain words for where a known problem that is not in the top five ended up. */
function whereLost(m: Match | undefined, doc: ReviewDocument): string {
  switch (m?.where ?? 'none') {
    case 'none':
      return 'It was never found by a lens.';
    case 'question':
      return 'It was returned as a question, not as a finding.';
    case 'also':
      return 'It was found and shown under Also found, but left out of the top five.';
    case 'candidate':
      return 'It was found by a lens, but left out of the top five and not shown.';
    case 'top':
      return 'It was in the top five.';
    case 'dropped': {
      const entry = doc.dropped.find((d) => d.candidate.id === m!.itemId);
      const reason = entry && entry.reason.trim() !== '' ? ` Its reason: ${md(entry.reason)}` : '';
      switch (entry?.stage) {
        case 'challenge':
          return `It was found, then dropped by the challenge.${reason}`;
        case 'anchor':
          return 'It was found, then dropped because the quoted code was not in the file.';
        case 'schema':
          return 'It was found, then dropped because the answer was not in the expected form.';
        case 'select':
          return `It was found, then left out of the top five and not shown.${reason}`;
        default:
          return 'It was found, then dropped.';
      }
    }
  }
}

/** The title of the item a match points at, when there is one. */
function itemTitle(m: Match | undefined, doc: ReviewDocument): string | null {
  if (!m || m.itemId === null) return null;
  if (m.where === 'question') {
    const q = doc.questions[Number(m.itemId.slice(1)) - 1];
    return q ? q.text : null;
  }
  const all = [...doc.findings, ...doc.dropped.map((d) => d.candidate), ...doc.candidates];
  return all.find((c) => c.id === m.itemId)?.title ?? null;
}

function missedLines(k: KnownProblem, m: Match | undefined, doc: ReviewDocument): string[] {
  const out = [`- **${md(k.id)}**: ${md(k.summary)}`, `  - ${whereLost(m, doc)}`];
  const title = itemTitle(m, doc);
  if (title !== null) out.push(`  - Nearest item${m?.partial ? ' (a partial match)' : ''}: ${md(title)}`);
  if (m && m.reason.trim() !== '') out.push(`  - The judge's reason: ${md(m.reason)}`);
  return out;
}

function findingLines(f: Finding): string[] {
  const line = f.anchor.startLine ?? f.lineHint;
  const where = line === null ? md(f.path) : `${md(f.path)}:${line}`;
  return [
    `- **${SEVERITY_WORD[f.severity]}**: ${md(f.title)}`,
    `  - Where: ${where}`,
    `  - What happens: ${md(f.happens)}`,
    `  - Why it matters: ${md(f.why)}`,
    '  - [ ] wrong  [ ] right',
  ];
}

/** Renders a replay run as Markdown for a reader who is not an engineer by training. */
export function renderReport(summary: RunSummary, cases: ReplayCase[], details: Details): string {
  const caseById = new Map(cases.map((c) => [c.id, c]));
  const kindOf = (s: CaseScore): ReplayCase['kind'] => caseById.get(s.caseId)?.kind ?? s.kind;
  const positives = summary.cases.filter((s) => kindOf(s) === 'positive');
  const negatives = summary.cases.filter((s) => kindOf(s) === 'negative');
  const total = (pick: (s: CaseScore) => number): number => positives.reduce((n, s) => n + pick(s), 0);
  const out: string[] = [];

  out.push(`# Replay ${md(summary.runId)}`, '', `Model: ${md(summary.model)}. Depth: ${md(summary.depth)}.`, '');

  const names = (scores: CaseScore[]): string => scores.map((s) => prName(caseById.get(s.caseId), s.caseId)).join(', ');
  const unfinished = (scores: CaseScore[]): CaseScore[] => scores.filter((s) => s.verdict === 'incomplete');

  out.push('## The two tests', '');
  const half = summary.meets.halfInTop;
  let first = 'At least half of the known problems should be in the top five. ';
  if (half === 'not tested') {
    first += 'Not tested in this run: there were no pull requests with known problems.';
  } else {
    first += `${summary.inTopTotal} of ${summary.knownTotal} were (${percent(summary.recallTop)}). ${yesNo(half)}.`;
    const failed = unfinished(positives);
    if (failed.length > 0) {
      first += ` ${plural(failed.length, 'The review', 'The reviews')} of ${failed.length} of these pull requests did not finish ` +
        `(${names(failed)}); ${plural(failed.length, 'its', 'their')} known problems are counted as missed.`;
    }
  }
  out.push(`1. ${first}`);

  const clean = summary.meets.cleanControls;
  let second = 'Clean pull requests should not be given wrong blocking findings. ';
  if (clean === 'not tested') {
    second += 'Not tested in this run: there were no clean pull requests.';
  } else {
    const n = negatives.length;
    second += `There ${plural(n, 'was', 'were')} ${n} clean ${plural(n, 'pull request', 'pull requests')} in this run.`;
    const flagged = summary.negativesWithBlockOrFix;
    if (clean === 'needs a human look') {
      second += ` This needs your look: ${flagged} clean ${plural(flagged, 'pull request was', 'pull requests were')} given a Block or Fix; ` +
        `${plural(flagged, 'it is', 'they are')} listed below.`;
    }
    const failed = unfinished(negatives);
    if (failed.length > 0) {
      second += ` ${plural(failed.length, 'The review', 'The reviews')} of ${failed.length} clean ` +
        `${plural(failed.length, 'pull request', 'pull requests')} did not finish (${names(failed)}), ` +
        `so ${plural(failed.length, 'it', 'they')} cannot be counted as clean.`;
    }
    if (clean === 'incomplete') second += ` This test has no answer until ${plural(failed.length, 'it is', 'they are')} run again.`;
    if (clean === true) second += ' None was given a Block or Fix. Yes.';
  }
  out.push(`2. ${second}`, '');

  out.push('## Other numbers', '');
  out.push(
    `- Counting every finding shown, not only the top five: ${total((s) => s.shown)} of ${summary.knownTotal} (${percent(summary.recallShown)}).`,
    `- Real defects only, leaving out pure questions: ${total((s) => s.defectsInTop)} of ${total((s) => s.knownDefects)} ` +
      `(${percent(summary.recallTopDefects)}) were in the top five.`,
    `- Partial matches: ${total((s) => s.partialInTop)} of the problems in the top five were only partly described.`,
    `- Problems that came back as a question instead of a finding: ${total((s) => s.asQuestion)}.`,
    `- Cross-file problems, which need a second file to see: ${total((s) => s.crossFileInTop)} of ${total((s) => s.crossFileKnown)} ` +
      `(${percent(summary.crossFileRecallTop)}) were in the top five.`,
    '',
  );

  out.push('## Each pull request', '');
  if (positives.length === 0) out.push('There were no pull requests with known problems in this run.', '');
  else out.push(...table(
    ['Pull request', 'Size (lines)', 'Known problems', 'In top five', 'Shown', 'Not shown'],
    positives.map((s) => {
      const c = caseById.get(s.caseId);
      const lines = c?.lines;
      return [prName(c, s.caseId), lines == null ? 'unknown' : count(lines), String(s.known), String(s.inTop), String(s.shown), String(s.known - s.shown)];
    }),
  ), '');

  const shared: string[] = [];
  for (const s of positives) {
    const c = caseById.get(s.caseId);
    const d = details[s.caseId];
    if (!c || !d) continue;
    for (const [itemId, knownIds] of sharedMatchItems(c, d.matches)) {
      const title = itemTitle(d.matches.find((m) => m.itemId === itemId), d.doc);
      shared.push(`- ${prName(c, s.caseId)}: ${md(itemId)}${title === null ? '' : ` (${md(title)})`} matched ${andList(knownIds.map(md))}.`);
    }
  }
  if (shared.length > 0) {
    out.push('## One finding matched to several known problems', '');
    out.push('The judge matched each of these to more than one known problem. Check that it really describes each of them.', '');
    out.push(...shared, '');
  }

  out.push('## What was missed and where it was lost', '');
  let anyListed = false;
  for (const s of positives) {
    const c = caseById.get(s.caseId);
    const d = details[s.caseId];
    if (!c || !d) {
      anyListed = true;
      out.push(`### ${prName(c, s.caseId)}`, '', 'Details not available.', '');
      continue;
    }
    const byKnown = new Map(d.matches.map((m) => [m.knownId, m]));
    const missed = c.known.filter((k) => byKnown.get(k.id)?.where !== 'top');
    if (missed.length === 0) continue;
    anyListed = true;
    out.push(`### ${prName(c, s.caseId)}`, '');
    for (const k of missed) out.push(...missedLines(k, byKnown.get(k.id), d.doc));
    out.push('');
  }
  if (positives.length === 0) out.push('There were no pull requests with known problems in this run.', '');
  else if (!anyListed) out.push('Nothing. Every known problem was in the top five.', '');

  out.push('## Findings on clean pull requests', '');
  out.push('These pull requests were approved with no comment. Mark each finding wrong or right.', '');
  for (const s of negatives) {
    const c = caseById.get(s.caseId);
    const d = details[s.caseId];
    out.push(`### ${prName(c, s.caseId)}`, '');
    if (!d) out.push('No review was saved for this pull request.', '');
    else if (d.doc.findings.length === 0) out.push('No findings shown.', '');
    else out.push(...d.doc.findings.flatMap(findingLines), '');
  }
  if (negatives.length === 0) out.push('No clean pull requests were in this run.', '');

  if (summary.incompleteCases.length > 0) {
    out.push('## Incomplete reviews', '');
    out.push('A step of these reviews failed, so they are not counted as clean.', '');
    for (const id of summary.incompleteCases) {
      out.push(`- ${prName(caseById.get(id), id)}`);
      for (const e of details[id]?.doc.stageErrors ?? []) out.push(`  - ${md(e.stage)}: ${md(e.message)}`);
    }
    out.push('');
  }

  out.push('## Time and tokens', '');
  out.push(...table(
    ['Pull request', 'Time', 'Tokens in', 'Tokens out', 'Agent runs'],
    [
      ...summary.cases.map((s) => [prName(caseById.get(s.caseId), s.caseId), duration(s.ms), count(s.inputTokens), count(s.outputTokens), count(s.agentRuns)]),
      ['Total', duration(summary.totals.ms), count(summary.totals.inputTokens), count(summary.totals.outputTokens), count(summary.totals.agentRuns)],
    ],
  ), '');

  out.push('## How to read this', '');
  out.push(
    'When a pull request was replayed, the rules written from that pull request were withheld, so the review could not simply remember the answer. ' +
      "The team's rule sheet was written after these reviews and could not be withheld, so these numbers may be better than real use. " +
      'The true test is the next pull requests the senior reviewer comments on.',
  );
  return `${out.join('\n')}\n`;
}
