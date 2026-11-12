import type { Brief } from '@airlock/shared';

const VERDICT_WORDS = { 'not-supported': 'Not supported', unclear: 'Unclear' } as const;

/** The brief's heading for a review of a merge of `base`: what was reviewed, as the document says. */
const mergeHeading = ({ base, kind }: MergeOf): string => (kind === 'by-hand'
  ? `A merge of ${base}: only what was changed by hand was reviewed`
  : `A merge of ${base}: git merged it without conflicts and nothing was changed by hand.`);

/** A first review of a merge of the base branch whose document says what was reviewed of it. */
export interface MergeOf { base: string; kind: 'by-hand' | 'nothing-by-hand' }

/** What the pull request does, and the claims that did not check out, each with its evidence. A part with nothing in it is left out. */
export function BriefBlock({ brief, merge }: { brief: Brief; /** When this is a review of a merge: its heading says what was reviewed. */ merge?: MergeOf }) {
  const claims = brief.claims.flatMap((c) => (c.verdict === 'verified' ? [] : [{ ...c, word: VERDICT_WORDS[c.verdict] }]));
  return (
    <>
      {brief.whatItDoes.length > 0 && (
        <section className="card">
          <h2 className="label">{merge === undefined ? 'What this does' : mergeHeading(merge)}</h2>
          <ul className="plain">
            {brief.whatItDoes.map((line, i) => <li key={i}>{line}</li>)}
          </ul>
        </section>
      )}
      {claims.length > 0 && (
        <section className="card">
          <h2 className="label">Claims to check</h2>
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
        </section>
      )}
    </>
  );
}
