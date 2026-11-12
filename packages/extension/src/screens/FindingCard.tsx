import type { Finding, PostRecord, PrSummary } from '@airlock/shared';
import { PostedMark } from './PostedMark';
import { fromText, locationText, severityWord } from './words';

/** One top finding: a checkbox for the fix prompt, and a button (the rest of the card) that opens its detail. */
export function FindingCard({ finding, rank, packs, selected, onToggle, onOpen, register, posted }: {
  finding: Finding;
  /** Its post record, when it is posted or its post's outcome is not known. */
  posted?: PostRecord | undefined;
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
        aria-label={`Select for the fix prompt: ${finding.title}`}
      />
      <button type="button" className="open" data-finding-id={finding.id} onClick={onOpen} ref={(node) => register(finding.id, node)}>
        <span className="head-line">
          <span className="rank">{rank}</span>
          <span className="sev">{severityWord(finding.severity)}</span>
        </span>
        <span className="title block">{finding.title}</span>
        <code className="path block">{locationText(finding)}</code>
        <span className="muted block">{`From: ${fromText(finding, packs)}`}</span>
        {raisedBy > 0 && <span className="muted block">{`Also raised by ${raisedBy} more`}</span>}
        {posted !== undefined && <PostedMark record={posted} link={false} />}
      </button>
    </li>
  );
}
