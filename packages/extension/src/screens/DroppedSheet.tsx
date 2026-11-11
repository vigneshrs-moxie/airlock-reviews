import type { Dropped } from '@airlock/shared';
import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import { Sheet } from './Sheet';
import { clipQuote, placeText, proofSide, stageWhere } from './words';

function Proof({ refutation }: { refutation: NonNullable<Dropped['refutation']> }) {
  // A recorded decision is shown in full; a quote of code is cut.
  const decision = refutation.role !== 'head' && refutation.role !== 'base';
  const [all, setAll] = useState(false);
  const quote = useRef<HTMLPreElement>(null);
  const shown = useRef(false);
  // Pressing Show all removes the button that had focus, so focus moves to the quote it revealed.
  useEffect(() => { if (all && !shown.current) { shown.current = true; quote.current?.focus(); } }, [all]);
  const clipped = !decision && clipQuote(refutation.quote) !== refutation.quote;
  return (
    <div className="proof">
      <span className="label">Proof</span>{' '}
      <code className="path">{placeText(refutation.path, refutation.line)}</code>{' · '}
      <span>{proofSide(refutation.role)}</span>
      <pre className="quote" tabIndex={-1} ref={quote}><code>{decision || all ? refutation.quote : clipQuote(refutation.quote)}</code></pre>
      {clipped && !all && <button type="button" className="btn small" onClick={() => setAll(true)}>Show all</button>}
    </div>
  );
}

/** What the review raised and then dropped, with the reason and the proof. An overlay inside the panel. */
export function DroppedSheet({ dropped, opener, onClose }: { dropped: readonly Dropped[]; opener: RefObject<HTMLElement | null>; onClose: () => void }) {
  const titleId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  return (
    <Sheet labelledBy={titleId} initialFocus={heading} returnFocusTo={opener} onClose={onClose}>
      <div className="row">
        <h2 className="title" id={titleId} tabIndex={-1} ref={heading}>{`Dropped: ${dropped.length}`}</h2>
        <button type="button" className="btn small close" onClick={onClose}>Close</button>
      </div>
      <p className="muted">Raised by a lens, then removed. Kept here so you can see nothing was hidden.</p>
      <ul className="plain">
        {dropped.map((d, i) => (
          <li key={i}>
            <div className="title">{d.candidate.title}</div>
            <div className="muted">{`Dropped ${stageWhere(d.stage)}: ${d.reason}`}</div>
            {d.refutation !== null && <Proof refutation={d.refutation} />}
          </li>
        ))}
      </ul>
    </Sheet>
  );
}
