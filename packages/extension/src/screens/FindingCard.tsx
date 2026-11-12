import type { Finding, PostRecord, PrSummary } from '@airlock/shared';
import type { ReactNode } from 'react';
import { PostedMark } from './PostedMark';
import { fromText, locationText, severityWord, statusWord } from './words';

/** One top finding: a checkbox for the fix prompt, and a button (the rest of the card) that opens its detail. */
export function FindingCard({ finding, rank, packs, selected, onToggle, onOpen, register, posted, after }: {
  finding: Finding;
  /** Its post record, when it is posted; its words go inside the card's button. */
  posted?: PostRecord | undefined;
  /** What goes under the card's button, outside it (a mark with its own controls). */
  after?: ReactNode;
  rank: number;
  packs: PrSummary['packs'];
  selected: boolean;
  onToggle: () => void;
  onOpen: () => void;
  register: (id: string, node: HTMLButtonElement | null) => void;
}) {
  const raisedBy = finding.alsoRaisedBy?.length ?? 0;
  return (
    <li className="card finding-card" data-severity={finding.severity}>
      <input
        type="checkbox" className="pick" checked={selected} onChange={onToggle}
        aria-label={`Select: ${finding.title}`}
      />
      <div className="card-main">
      <button type="button" className="open" data-finding-id={finding.id} onClick={onOpen} ref={(node) => register(finding.id, node)}>
        <span className="head-line">
          <span className="rank">{rank}</span>
          <span className="sev">{severityWord(finding.severity)}</span>
          {finding.status !== null && <span className="status" data-testid="status">{statusWord(finding.status)}</span>}
        </span>
        <span className="title block">{finding.title}</span>
        <code className="path block">{locationText(finding)}</code>
        <span className="muted block">{`From: ${fromText(finding, packs)}`}</span>
        {raisedBy > 0 && <span className="muted block">{`Also raised by ${raisedBy} more`}</span>}
        {posted !== undefined && posted.outcome === 'posted' && <PostedMark record={posted} link={false} />}
      </button>
      {after}
      </div>
    </li>
  );
}
