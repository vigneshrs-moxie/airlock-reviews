import { verdictWords, type Finding, type ReviewDocument, type Severity, type VerdictLabel } from '@airlock/shared';
import type { Ref } from 'react';
import type { NotesLine } from '../state/notes';
import { depthWord } from './words';

/** A count in words, with the colour class that is its second cue. */
export interface Chip { text: string; tone: string }

const WORST_FIRST: readonly Severity[] = ['block', 'fix', 'ask', 'note'];
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
const KIND_WORDS: Record<Severity, (n: number) => string> = {
  block: (n) => `${n} blocking`,
  fix: (n) => `${n} to fix`,
  ask: (n) => plural(n, 'question', 'questions'),
  note: (n) => plural(n, 'note', 'notes'),
};

/** The worst kind among the open findings; null when none is open. */
export function worstKind(open: readonly Finding[]): Severity | null {
  return WORST_FIRST.find((kind) => open.some((f) => f.severity === kind)) ?? null;
}

/** The open findings counted by kind, worst first, a kind with none left out. */
export function kindChips(open: readonly Finding[]): Chip[] {
  return WORST_FIRST.flatMap((kind) => {
    const n = open.filter((f) => f.severity === kind).length;
    return n === 0 ? [] : [{ text: KIND_WORDS[kind](n), tone: `sev-${kind}` }];
  });
}

/** The engine's labels that approve the pull request: the only ones whose verdict may read as clear (green). */
const APPROVING = new Set<VerdictLabel>(['approve', 'ready-for-pr2']);

/**
 * Whether the verdict may be shown as clear: an approving label, nothing open, no question left to settle (the engine also
 * writes its own limits there), and nothing that says the review saw less than all of the change (no stage error, no
 * limit, no note) on the commit the pull request is at (not stale).
 */
export function readsClear(
  doc: Pick<ReviewDocument, 'verdict' | 'stageErrors' | 'limits' | 'notes' | 'questions'>, open: readonly Finding[], stale: boolean,
): boolean {
  return APPROVING.has(doc.verdict.label) && open.length === 0 && doc.stageErrors.length === 0 && doc.questions.length === 0
    && (doc.limits ?? []).length === 0 && (doc.notes ?? []).length === 0 && !stale;
}

/** What a re-review changed: fixed, still open, new and moved, each left out when it is none. */
export function sinceChips(open: readonly Finding[], fixed: number): Chip[] {
  const count = (status: Finding['status']): number => open.filter((f) => f.status === status).length;
  return [
    { n: fixed, text: `${fixed} fixed`, tone: 'sev-ok' },
    { n: count('still-open'), text: `${count('still-open')} still open`, tone: 'sev-note' },
    { n: count('new'), text: `${count('new')} new`, tone: 'sev-fix' },
    { n: count('moved'), text: `${count('moved')} moved`, tone: 'sev-note' },
  ].flatMap(({ n, text, tone }) => (n === 0 ? [] : [{ text, tone }]));
}

function Chips({ chips, label }: { chips: readonly Chip[]; label: string }) {
  return (
    <ul className="plain ap-chips" aria-label={label}>
      {chips.map((c) => <li key={c.text} className={`ap-chip ${c.tone}`}>{c.text}</li>)}
    </ul>
  );
}

/**
 * The card at the top of a finished review: the verdict in words (the engine's), coloured by the worst open kind, green
 * only when it reads clear (`readsClear`); its sentence; the open findings counted by kind, and how many were dismissed;
 * on a re-review what changed since the last one, the range it covered and its notes; when and how deep it was reviewed;
 * and what the notes on GitHub's page did, with its Reload button.
 */
export function VerdictStrip({ doc, open, dismissed, stale, empty, range, notesLine, onReloadNotes, headingRef }: {
  doc: ReviewDocument;
  /** The open findings: top and also found, none dismissed. */
  open: readonly Finding[];
  /** How many of the review's findings are dismissed: a quiet chip, so the engine's sentence (which counts them) adds up. */
  dismissed: number;
  /** The pull request has moved on since this review. */
  stale: boolean;
  /** The sentence for a review with no open finding; null when there are some. */
  empty: string | null;
  /** The line saying what a re-review covered; null for none. */
  range: string | null;
  notesLine: NotesLine | null;
  onReloadNotes?: (() => void) | undefined;
  headingRef: Ref<HTMLHeadingElement>;
}) {
  const worst = worstKind(open);
  const tone = worst !== null ? `sev-${worst}` : readsClear(doc, open, stale) ? 'sev-ok' : '';
  const kinds = [...kindChips(open), ...(dismissed > 0 ? [{ text: `${dismissed} dismissed`, tone: 'ap-chip-quiet' }] : [])];
  // A re-review's notes say what it covered, so they stay in the strip; a first review's are in About this review.
  const notes = doc.previous === undefined ? [] : (doc.notes ?? []);
  const since = doc.previous === undefined ? [] : sinceChips(open, doc.fixed?.length ?? 0);
  return (
    <section className="card verdict ap-verdict">
      <h2 className={`ap-vword ${tone}`} tabIndex={-1} data-focus="verdict" ref={headingRef}>{verdictWords(doc.verdict.label, doc.pr.stage)}</h2>
      <p className="ap-headline">{doc.verdict.sentence}</p>
      {kinds.length > 0 && <Chips chips={kinds} label="Finding counts" />}
      {empty !== null && <p>{empty}</p>}
      {since.length > 0 && (
        <>
          <span className="label">Since the last review</span>
          <Chips chips={since} label="Since the last review" />
        </>
      )}
      {range !== null && <p>{range}</p>}
      {notes.map((note, i) => <p key={i}>{note}</p>)}
      <p className="muted">{`Reviewed at ${doc.pr.headSha.slice(0, 7)} · ${depthWord(doc.depth)}`}</p>
      {notesLine !== null && <p>{notesLine.text}</p>}
      {notesLine?.reload === true && (
        <button type="button" className="btn small ap-start" onClick={() => onReloadNotes?.()}>Reload the GitHub tab</button>
      )}
    </section>
  );
}
