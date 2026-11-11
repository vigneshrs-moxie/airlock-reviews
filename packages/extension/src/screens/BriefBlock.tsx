import type { Brief } from '@airlock/shared';

const VERDICT_WORDS = { 'not-supported': 'Not supported', unclear: 'Unclear' } as const;

/** What the pull request does, and the claims that did not check out, each with its evidence. A part with nothing in it is left out. */
export function BriefBlock({ brief }: { brief: Brief }) {
  const claims = brief.claims.flatMap((c) => (c.verdict === 'verified' ? [] : [{ ...c, word: VERDICT_WORDS[c.verdict] }]));
  return (
    <>
      {brief.whatItDoes.length > 0 && (
        <section className="card">
          <h2 className="label">What this does</h2>
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
