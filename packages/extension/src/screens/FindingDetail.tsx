import type { Finding, PrSummary } from '@airlock/shared';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Timers } from '../client/timers';
import { CopyButton } from './CopyButton';
import { fromText, locationText, placeText, severityWord } from './words';

export interface JumpTarget { path: string; line: number | null }
/** Takes the person to a place and says in a sentence what it did. */
export type OnJump = (place: JumpTarget) => Promise<string>;

export const notConnected: OnJump = () => Promise.resolve('Jumping is not connected yet.');

function Part({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="part">
      <h3 className="label">{title}</h3>
      {children}
    </section>
  );
}

export interface FindingDetailProps {
  finding: Finding;
  packs: PrSummary['packs'];
  previous: Finding | null;
  next: Finding | null;
  /** Dismiss needs the service; false when the review is shown read-only. */
  canDismiss: boolean;
  fixPrompt: () => string;
  onBack: () => void;
  onOpen: (finding: Finding) => void;
  onJump: OnJump;
  onDismiss: (finding: Finding) => void;
  timers?: Timers;
}

/** One finding in full. Keyed by the caller on the finding's id, so each finding starts with its own focus and notes. */
export function FindingDetail({ finding, packs, previous, next, canDismiss, fixPrompt, onBack, onOpen, onJump, onDismiss, timers }: FindingDetailProps) {
  const title = useRef<HTMLHeadingElement>(null);
  const [note, setNote] = useState<{ key: string; text: string } | null>(null);
  useEffect(() => title.current?.focus(), []);

  const jump = (key: string, place: JumpTarget): void => {
    const said = (text: string): void => setNote({ key, text });
    const failed = (): void => said('Airlock could not jump to that place.');
    try {
      Promise.resolve(onJump(place)).then(said, failed);
    } catch {
      failed();
    }
  };
  const noteFor = (key: string) => (note?.key === key ? <p className="muted" role="status">{note.text}</p> : null);

  return (
    <>
      <button type="button" className="btn small back" onClick={onBack}>Back to the review</button>
      <section className="card">
        <h2 className="title" tabIndex={-1} ref={title}>{finding.title}</h2>
        <p><span className="sev">{severityWord(finding.severity)}</span></p>
        <code className="path block">{locationText(finding)}</code>
        <Part title="What happens"><p>{finding.happens}</p></Part>
        <Part title="Why"><p>{finding.why}</p></Part>
        {finding.suggestedChange.trim() !== '' && <Part title="Suggested change"><p>{finding.suggestedChange}</p></Part>}
        <Part title="The code"><pre className="quote"><code>{finding.quote}</code></pre></Part>
        {finding.connected.length > 0 && (
          <Part title="Also involves">
            <ul className="plain">
              {finding.connected.map((place, i) => (
                <li key={i}>
                  <button type="button" className="place" onClick={() => jump(`place-${i}`, { path: place.path, line: place.line })}>
                    <code className="path">{placeText(place.path, place.line)}</code>
                    <span className="muted">{place.role}</span>
                  </button>
                  {noteFor(`place-${i}`)}
                </li>
              ))}
            </ul>
          </Part>
        )}
        {finding.checked.trim() !== '' && <Part title="Checked"><p>{finding.checked}</p></Part>}
        {finding.wouldBeWrongIf.trim() !== '' && <Part title="Would be wrong if"><p>{finding.wouldBeWrongIf}</p></Part>}
        <Part title="From"><p>{fromText(finding, packs)}</p></Part>
      </section>
      <div className="actions">
        <div className="action">
          <button type="button" className="btn" onClick={() => jump('own', { path: finding.path, line: finding.anchor.startLine })}>Jump to line</button>
          {noteFor('own')}
        </div>
        <div className="action"><CopyButton text={fixPrompt} label="Copy fix prompt" {...(timers ? { timers } : {})} /></div>
        <div className="action">
          <button type="button" className="btn" disabled={!canDismiss} onClick={() => onDismiss(finding)}>Dismiss</button>
        </div>
      </div>
      <div className="actions">
        <button type="button" className="btn" disabled={previous === null} onClick={() => previous && onOpen(previous)}>Previous</button>
        <button type="button" className="btn" disabled={next === null} onClick={() => next && onOpen(next)}>Next</button>
      </div>
    </>
  );
}
