import { verdictWords } from '@airlock/shared';
import type { Finding, ReviewDocument, Severity, VerdictLabel } from '@airlock/shared';

const WIDTH = 100;
const FILES_PER_LAYER_WHEN_LONG = 5;
const LONG_MAP_FILES = 40;
const CODE_QUOTE_LIMIT = 160;

const SEVERITY_WORDS: Record<Severity, string> = { block: 'Block', fix: 'Fix', ask: 'Ask', note: 'Note' };
const SEVERITY_COLORS: Record<Severity, string> = { block: '31', fix: '33', ask: '36', note: '2' };
const VERDICT_COLORS: Record<VerdictLabel, string> = {
  'not-ready': '31', 'split-first': '31', 'request-changes': '31', 'ready-for-pr2': '32', approve: '32',
  'approve-after-fixes': '33', incomplete: '33',
};
const STAGE_WORDS = { pr1: 'PR #1 (fork to org branch)', pr2: 'PR #2 (into staging)', pr3: 'PR #3 (release)', other: '' };
const STATUS_WORDS = { new: 'New', 'still-open': 'Still open', fixed: 'Fixed', moved: 'Moved' };

/** Wraps prose on word boundaries; the prefix counts toward the width and continuation lines use `hang`. */
function wrap(text: string, prefix: string, hang: string = ' '.repeat(prefix.length)): string[] {
  const lines: string[] = [];
  let line = prefix;
  let empty = true;
  for (const word of text.split(/\s+/).filter((w) => w !== '')) {
    if (!empty && line.length + 1 + word.length > WIDTH) {
      lines.push(line);
      line = hang;
      empty = true;
    }
    line += (empty ? '' : ' ') + word;
    empty = false;
  }
  lines.push(line);
  return lines;
}

/**
 * Makes a document string safe to print: runs of carriage returns, line feeds and tabs become one space,
 * and every other control character (C0, DEL, C1) and the line and paragraph separators are removed.
 */
export function cleanForTerminal(s: string): string {
  return s.replace(/[\r\n\t]+/g, ' ').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '');
}

/** Cleans every string in the document up front, so the renderer cannot forget a field. */
function cleanAll<T>(value: T): T {
  if (typeof value === 'string') return cleanForTerminal(value) as T;
  if (Array.isArray(value)) return value.map(cleanAll) as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, cleanAll(v)])) as T;
  }
  return value;
}

function paint(on: boolean, code: string, text: string): string {
  return on ? `\u001b[${code}m${text}\u001b[0m` : text;
}

function number(n: number): string {
  return n.toLocaleString('en-US');
}

function section(heading: string, body: string[]): string[] {
  return body.length === 0 ? [] : [heading, '', ...body];
}

function location(f: Finding): string {
  const { status, startLine, endLine } = f.anchor;
  const line = startLine ?? f.lineHint;
  if (status === 'outside-diff') return `${f.path}${line === null ? '' : `:${line}`}, outside the diff`;
  if (line === null) return f.path;
  return endLine !== null && endLine !== line && status === 'in-diff' ? `${f.path}:${line}-${endLine}` : `${f.path}:${line}`;
}

function renderFinding(f: Finding, n: number, color: boolean, packTitle: PackTitle): string[] {
  const status = f.status === null ? '' : ` (${STATUS_WORDS[f.status]})`;
  const word = SEVERITY_WORDS[f.severity];
  const title = wrap(`${n}. [${word}] ${f.title}${status}`, '', ' '.repeat(`${n}. `.length));
  title[0] = title[0]!.replace(`[${word}]`, `[${paint(color, SEVERITY_COLORS[f.severity], word)}]`);
  const out = [...title, `   ${location(f)}`];
  const field = (label: string, text: string) => out.push(...wrap(text, `   ${label} `));
  field('Happens:', f.happens);
  field('Why:', f.why);
  if (f.suggestedChange.trim() !== '') field('Change:', f.suggestedChange);
  if (f.connected.length > 0) {
    out.push('   Also involves:');
    for (const p of f.connected) out.push(`     ${p.path}:${p.line ?? '?'}  ${p.role}`);
  }
  if (f.checked.trim() !== '') field('Checked:', f.checked);
  out.push(`   From: ${sourceWords(f.source)}`);
  const also = alsoRaisedBy(f, packTitle);
  if (also !== null) out.push(...wrap(also, '   '));
  return out;
}

const sourceWords = (s: Finding['source']): string => `${s.pack} · ${s.ruleId ?? s.lens ?? 'unknown'}`;

/** A pack's title from the document, or its id when the document has no title for it. */
type PackTitle = (packId: string) => string;
const packTitles = (doc: ReviewDocument): PackTitle => {
  const titles = new Map(doc.packs.flatMap((p) => (p.title === undefined ? [] : [[p.id, p.title] as const])));
  return (id) => titles.get(id) ?? id;
};

/** `Also raised by: <pack title · lens or rule>, …` for a finding that absorbed duplicates, else null. */
function alsoRaisedBy(f: Finding, packTitle: PackTitle): string | null {
  const sources = f.alsoRaisedBy ?? [];
  return sources.length === 0 ? null
    : `Also raised by: ${sources.map((s) => sourceWords({ ...s, pack: packTitle(s.pack) })).join(', ')}`;
}

function bullets(items: string[]): string[] {
  return items.flatMap((t) => wrap(t, '- ', '  '));
}

function droppedItem(d: ReviewDocument['dropped'][number]): string[] {
  const head = `- ${d.candidate.title} (${d.stage}: ${d.reason})`;
  const r = d.refutation;
  if (r === null) return [head];
  const place = `${r.path}${r.line === null ? '' : `:${r.line}`} (${r.role})`;
  if (r.role === 'head' || r.role === 'base') {
    const quote = [...r.quote].length > CODE_QUOTE_LIMIT ? `${[...r.quote].slice(0, CODE_QUOTE_LIMIT).join('')}…` : r.quote;
    return [head, `  proof: ${place} "${quote}"`];
  }
  return [head, ...wrap(`proof: ${place} "${r.quote}"`, '  ', '    ')];
}

/** For a re-review, what it covered: only the push since the earlier head, or the whole pull request again. */
function rereviewLine(doc: ReviewDocument): string[] {
  if (doc.previous === undefined) return [];
  const earlier = doc.previous.headSha.slice(0, 7);
  return [doc.range.kind === 'rereview'
    ? `Review of the push ${earlier} to ${doc.range.headSha.slice(0, 7)}`
    : `Reviewed again in full since ${earlier}`];
}

function countsLine(doc: ReviewDocument): string {
  const c = doc.verdict.counts;
  return (['block', 'fix', 'ask', 'note'] as const)
    .filter((k) => c[k] > 0)
    .map((k) => `${c[k]} ${SEVERITY_WORDS[k]}`)
    .join(', ');
}

function changeMap(doc: ReviewDocument): string[] {
  const tiers = new Map(doc.files.map((f) => [f.path, f.tier]));
  const total = doc.map.cohorts.flatMap((c) => c.layers).reduce((n, l) => n + l.files.length, 0) + doc.map.standalone.length;
  const long = total > LONG_MAP_FILES;
  const files = (paths: string[], withTier: boolean): string[] => {
    const shown = long ? paths.slice(0, FILES_PER_LAYER_WHEN_LONG) : paths;
    const out = shown.map((p) => `     ${p}${withTier ? `  (${tiers.get(p) ?? '?'})` : ''}`);
    if (shown.length < paths.length) out.push(`     … ${paths.length - shown.length} more`);
    return out;
  };
  const out: string[] = [];
  for (const cohort of doc.map.cohorts) {
    out.push(cohort.title);
    cohort.layers.forEach((layer, i) => {
      out.push(`  ${i + 1}. ${layer.title} [${layer.kind}]`, ...files(layer.files, true));
    });
  }
  if (doc.map.standalone.length > 0) out.push('Standalone:', ...files(doc.map.standalone, false));
  return out;
}

function timingTable(doc: ReviewDocument): string[] {
  if (doc.timings.length === 0) return [];
  const showCost = doc.timings.some((t) => t.costUsd !== null);
  const sum = (pick: (t: ReviewDocument['timings'][number]) => number) => doc.timings.reduce((n, t) => n + pick(t), 0);
  const rows: string[][] = [['Stage', 'Seconds', 'Runs', 'Input', 'Output', ...(showCost ? ['Cost (USD)'] : [])]];
  for (const t of doc.timings) {
    rows.push([t.stage, (t.ms / 1000).toFixed(1), String(t.agentRuns), number(t.inputTokens), number(t.outputTokens),
      ...(showCost ? [t.costUsd === null ? '-' : t.costUsd.toFixed(2)] : [])]);
  }
  rows.push(['total', (sum((t) => t.ms) / 1000).toFixed(1), String(sum((t) => t.agentRuns)), number(sum((t) => t.inputTokens)),
    number(sum((t) => t.outputTokens)), ...(showCost ? [sum((t) => t.costUsd ?? 0).toFixed(2)] : [])]);
  const widths = rows[0]!.map((_, c) => Math.max(...rows.map((r) => r[c]!.length)));
  const table = rows.map((r) => r.map((cell, c) => (c === 0 ? cell.padEnd(widths[c]!) : cell.padStart(widths[c]!))).join('  ').trimEnd());
  return [...table, ...elapsed(doc)];
}

/** `Elapsed: <m> min <s> s` from the review's start to its end. Stages overlap, so this is not the sum of their seconds. */
function elapsed(doc: ReviewDocument): string[] {
  const ms = doc.startedAt === undefined ? Number.NaN : Date.parse(doc.createdAt) - Date.parse(doc.startedAt);
  if (!Number.isFinite(ms) || ms < 0) return [];
  const seconds = Math.round(ms / 1000);
  return [`Elapsed: ${Math.floor(seconds / 60)} min ${seconds % 60} s`];
}

export function renderReview(input: ReviewDocument, opts: { color?: boolean } = {}): string {
  const doc = cleanAll(input);
  const color = opts.color ?? false;
  const { pr, verdict } = doc;
  const stage = STAGE_WORDS[pr.stage];
  const packs = doc.packs.map((p) => `${p.id}@${p.version.slice(0, 7)}`).join(', ') || 'none';
  const header = [
    `${pr.repo} #${pr.number}  ${pr.title}`,
    [...(stage === '' ? [] : [stage]), doc.depth, `reviewed ${pr.headSha.slice(0, 7)}`, `packs: ${packs}`].join(' · '),
    ...rereviewLine(doc),
  ];
  const verdictBlock = [
    paint(color, VERDICT_COLORS[verdict.label], verdictWords(verdict.label, pr.stage)),
    ...wrap(verdict.sentence, ''),
    ...(countsLine(doc) === '' ? [] : [countsLine(doc)]),
  ];

  const top = doc.findings.filter((f) => f.bucket === 'top').sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));
  const also = doc.findings.filter((f) => f.bucket === 'also');
  const claims = doc.brief.claims.filter((c) => c.verdict !== 'verified');
  const packTitle = packTitles(doc);

  const blocks: string[][] = [
    header,
    verdictBlock,
    section('What this does', bullets(doc.brief.whatItDoes)),
    section('Claims', bullets(claims.map((c) => `${c.verdict === 'unclear' ? 'Unclear' : 'Not supported'}: ${c.text} (${c.evidence})`))),
    section('Findings', top.flatMap((f, i) => [...(i > 0 ? [''] : []), ...renderFinding(f, i + 1, color, packTitle)])),
    section('Also found', also.flatMap((f) => {
      const line = f.anchor.startLine ?? f.lineHint;
      const status = f.status === null ? '' : ` (${STATUS_WORDS[f.status]})`;
      const head = `- [${paint(color, SEVERITY_COLORS[f.severity], SEVERITY_WORDS[f.severity])}] ${f.title}${status}  (${f.path}${line === null ? '' : `:${line}`})`;
      const others = alsoRaisedBy(f, packTitle);
      return others === null ? [head] : [head, ...wrap(others, '  ')];
    })),
    section(`Fixed since the last review (${(doc.fixed ?? []).length})`, (doc.fixed ?? []).flatMap((f) => [
      `- [${paint(color, SEVERITY_COLORS[f.severity], SEVERITY_WORDS[f.severity])}] ${f.title}  (${f.path})`,
      ...wrap(f.checked, '  '),
    ])),
    section('Questions', bullets(doc.questions.map((q) => q.text))),
    section('Whose call', bullets(doc.whoseCall)),
    section('Check after merge', doc.checksAfterMerge.flatMap((t, i) => wrap(t, `${i + 1}. `))),
    section('Change map', changeMap(doc)),
    section('Not reviewed', doc.files.filter((f) => f.tier === 'ignored').map((f) => `- ${f.path}: ${f.reason}`)),
    section('Not shown to the reviewer', bullets(doc.limits ?? [])),
    section('Notes', bullets(doc.notes ?? [])),
    section(`Dropped: ${doc.dropped.length}`, doc.dropped.flatMap(droppedItem)),
    section('Stage errors', doc.stageErrors.map((e) => `- ${e.stage}${e.cohortId === null ? '' : `, cohort ${e.cohortId}`}: ${e.message}`)),
    section('Timing', timingTable(doc)),
  ];
  return blocks.filter((b) => b.length > 0).map((b) => b.join('\n')).join('\n\n') + '\n';
}
