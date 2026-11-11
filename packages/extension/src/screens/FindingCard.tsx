import type { Finding, PrSummary } from '@airlock/shared';
import { fromText, locationText, severityWord } from './words';

/** One top finding: a checkbox for the fix prompt, and a button (the rest of the card) that opens its detail. */
export function FindingCard({ finding, rank, packs, selected, onToggle, onOpen, register }: {
  finding: Finding;
  rank: number;
  packs: PrSummary['packs'];
  selected: boolean;
  onToggle: () => void;
  onOpen: () => void;
  register: (id: string, node: HTMLButtonElement | null) => void;
}) {
  return (
    <li className="card finding-card" data-severity={finding.severity}>
      <input
        type="checkbox" className="pick" checked={selected} onChange={onToggle}
        aria-label={`Select for the fix prompt: ${finding.title}`}
      />
      <button type="button" className="open" onClick={onOpen} ref={(node) => register(finding.id, node)}>
        <span className="head-line">
          <span className="rank">{rank}</span>
          <span className="sev">{severityWord(finding.severity)}</span>
        </span>
        <span className="title block">{finding.title}</span>
        <code className="path block">{locationText(finding)}</code>
        <span className="muted block">{`From: ${fromText(finding, packs)}`}</span>
      </button>
    </li>
  );
}
