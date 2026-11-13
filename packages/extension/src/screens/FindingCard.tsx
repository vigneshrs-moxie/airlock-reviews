import { STATUS_WORD, type Finding, type PostRecord } from '@airlock/shared';
import type { ReactNode } from 'react';
import { EndInView } from './EndInView';
import { POSTED_WORD } from './PostedMark';
import { shortTitle } from './summary';
import { locationText, severityWord } from './words';

const STATUS_TONE: Record<NonNullable<Finding['status']>, string> = { new: 'sev-fix', 'still-open': 'sev-note', moved: 'sev-note', fixed: 'sev-ok' };

/**
 * One finding as one row: its kind as a word, a title of at most two lines and its place on one line,
 * cut at its start when too long so the file name and the line number stay in view. The whole row is
 * one button that opens the finding. While the list is in select mode a checkbox stands before it. On a re-review the
 * row says New, Still open or Moved (`showStatus`); a posted finding says Posted.
 */
export function FindingCard({ finding, showStatus, selecting, selected, onToggle, onOpen, register, posted, after }: {
  finding: Finding;
  showStatus: boolean;
  /** True while the list shows a checkbox on every row. */
  selecting: boolean;
  selected: boolean;
  onToggle: () => void;
  onOpen: () => void;
  register: (id: string, node: HTMLButtonElement | null) => void;
  /** Its post record, when it is posted or its post's outcome is not known. */
  posted?: PostRecord | undefined;
  /** What goes under the row's button, outside it (a mark with its own controls). */
  after?: ReactNode;
}) {
  const status = showStatus ? finding.status : null;
  return (
    <li className="finding-card ap-item" data-severity={finding.severity}>
      {selecting && (
        <input type="checkbox" className="ap-pick" checked={selected} onChange={onToggle} aria-label={`Select: ${finding.title}`} />
      )}
      <button type="button" className="open ap-row" data-finding-id={finding.id} onClick={onOpen} ref={(node) => register(finding.id, node)}>
        <span className={`ap-sev sev-${finding.severity}`}>{severityWord(finding.severity)}</span>
        <span className="ap-row-main">
          <span className="title ap-row-title">{shortTitle(finding)}</span>
          <span className="ap-row-sub">
            <EndInView className="path" text={locationText(finding)} />
            {status !== null && <span className={`ap-tag ${STATUS_TONE[status]}`} data-testid="status">{STATUS_WORD[status]}</span>}
            {posted?.outcome === 'posted' && <span className="ap-tag sev-ok">{POSTED_WORD}</span>}
          </span>
        </span>
        <span className="ap-go" aria-hidden="true" />
      </button>
      {after}
    </li>
  );
}
