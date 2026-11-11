import type { Dropped } from '@airlock/shared';
import { useEffect, useId, useRef, useState } from 'react';
import { clipQuote, placeText, proofSide, stageWhere } from './words';

function Proof({ refutation }: { refutation: NonNullable<Dropped['refutation']> }) {
  // A recorded decision is shown in full; a quote of code is cut.
  const decision = refutation.role !== 'head' && refutation.role !== 'base';
  const [all, setAll] = useState(false);
  const clipped = !decision && clipQuote(refutation.quote) !== refutation.quote;
  return (
    <div className="proof">
      <span className="label">Proof</span>{' '}
      <code className="path">{placeText(refutation.path, refutation.line)}</code>{' · '}
      <span>{proofSide(refutation.role)}</span>
      <pre className="quote"><code>{decision || all ? refutation.quote : clipQuote(refutation.quote)}</code></pre>
      {clipped && !all && <button type="button" className="btn small" onClick={() => setAll(true)}>Show all</button>}
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

  // Tab and Shift+Tab go round the sheet's buttons and never leave it.
  const trap = (event: React.KeyboardEvent): void => {
    if (event.key !== 'Tab') return;
    const buttons = [...(sheet.current?.querySelectorAll<HTMLElement>('button:not(:disabled)') ?? [])];
    const last = buttons.length - 1;
    const at = buttons.indexOf(document.activeElement as HTMLElement);
    if (last < 0) return;
    if (event.shiftKey && at <= 0) { event.preventDefault(); buttons[last]?.focus(); }
    else if (!event.shiftKey && at === last) { event.preventDefault(); buttons[0]?.focus(); }
  };

  return (
    <div className="sheet" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
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
              <div className="muted">{`Dropped ${stageWhere(d.stage)}: ${d.reason}`}</div>
              {d.refutation !== null && <Proof refutation={d.refutation} />}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
