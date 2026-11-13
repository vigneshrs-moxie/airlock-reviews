import type { Brief } from '@airlock/shared';

const VERDICT_WORDS = { 'not-supported': 'Not supported', unclear: 'Unclear' } as const;

/** The brief's heading for a review of a merge of `base`: what was reviewed, as the document says. */
const mergeHeading = ({ base, kind }: MergeOf): string => (kind === 'by-hand'
  ? `A merge of ${base}: only what was changed by hand was reviewed`
  : `A merge of ${base}: git merged it without conflicts and nothing was changed by hand.`);

/** A first review of a merge of the base branch whose document says what was reviewed of it. */
export interface MergeOf { base: string; kind: 'by-hand' | 'nothing-by-hand' }

/** The claims that did not check out, each with its word. */
const claimsOf = (brief: Brief) => brief.claims.flatMap((c) => (c.verdict === 'verified' ? [] : [{ ...c, word: VERDICT_WORDS[c.verdict] }]));

/** How many lines the brief shows: what it does, and the claims to check. */
export const briefPoints = (brief: Brief): number => brief.whatItDoes.length + claimsOf(brief).length;

/**
 * What the pull request does, and the claims that did not check out, each with its evidence. A part with nothing in it is
 * left out. `nested`: inside the review's "What it does" fold, which names it, so the parts are not cards and only a
 * merge's heading and the claims have a heading.
 */
export function BriefBlock({ brief, merge, nested = false }: {
  brief: Brief;
  /** When this is a review of a merge: its heading says what was reviewed. */
  merge?: MergeOf;
  nested?: boolean;
}) {
  const claims = claimsOf(brief);
  const Part = nested ? 'div' : 'section';
  const Heading = nested ? 'h4' : 'h2';
  return (
    <>
      {brief.whatItDoes.length > 0 && (
        <Part className={nested ? 'ap-part' : 'card'}>
          {(!nested || merge !== undefined) && <Heading className="label">{merge === undefined ? 'What this does' : mergeHeading(merge)}</Heading>}
          <ul className={nested ? 'plain ap-points' : 'plain'}>
            {brief.whatItDoes.map((line, i) => <li key={i}>{line}</li>)}
          </ul>
        </Part>
      )}
      {claims.length > 0 && (
        <Part className={nested ? 'ap-part' : 'card'}>
          <Heading className="label">Claims to check</Heading>
          <ul className="plain">
            {claims.map((c, i) => (
              <li key={i}>
                <div>{c.text}</div>
                <div className="muted">
                  <strong>{c.word}</strong>
                  {c.evidence !== '' && <>{' · '}<span>{c.evidence}</span></>}
                </div>
              </li>
            ))}
          </ul>
        </Part>
      )}
    </>
  );
}
