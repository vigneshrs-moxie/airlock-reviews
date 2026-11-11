import type { Dropped } from '@airlock/shared';
import { useEffect, useId, useRef } from 'react';
import { clipQuote, placeText, proofSide } from './words';

function Proof({ refutation }: { refutation: NonNullable<Dropped['refutation']> }) {
  // A recorded decision is shown in full; a quote of code is cut.
  const decision = refutation.role !== 'head' && refutation.role !== 'base';
  return (
    <div className="proof">
      <span className="label">Proof</span>{' '}
      <code className="path">{placeText(refutation.path, refutation.line)}</code>{' · '}
      <span>{proofSide(refutation.role)}</span>
      <pre className="quote"><code>{decision ? refutation.quote : clipQuote(refutation.quote)}</code></pre>
    </div>
  );
}

/** What the review raised and then dropped, with the reason and the proof. An overlay inside the panel. */
export function DroppedSheet({ dropped, onClose }: { dropped: readonly Dropped[]; onClose: () => void }) {
  const titleId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const sheet = useRef<HTMLDivElement>(null);

  useEffect(() => {
    heading.current?.focus();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // The close button is the only thing in the sheet to tab to, so Tab stays on it.
  const trap = (event: React.KeyboardEvent): void => {
    if (event.key !== 'Tab') return;
    event.preventDefault();
    sheet.current?.querySelector('button')?.focus();
  };

  return (
    <div className="sheet">
      <div className="sheet-body" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={sheet} onKeyDown={trap}>
        <div className="row">
          <h2 className="title" id={titleId} tabIndex={-1} ref={heading}>{`Dropped: ${dropped.length}`}</h2>
          <button type="button" className="btn small close" onClick={onClose}>Close</button>
        </div>
        <p className="muted">Raised by a lens, then removed. Kept here so you can see nothing was hidden.</p>
        <ul className="plain">
          {dropped.map((d, i) => (
            <li key={i}>
              <div className="title">{d.candidate.title}</div>
              <div className="muted">{`Dropped at ${d.stage}: ${d.reason}`}</div>
              {d.refutation !== null && <Proof refutation={d.refutation} />}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
