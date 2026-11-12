import type { Dismissal } from '@airlock/shared';
import type { DismissedFinding } from '../state/selection';
import { dismissReasonWord, severityWord } from './words';

/** Findings the person dismissed, one row each: the kind, the title, the reason, the text they saved and a Restore button. */
export function DismissedList({ items, canRestore, onRestore }: {
  items: readonly DismissedFinding[];
  canRestore: boolean;
  onRestore: (dismissal: Dismissal) => void;
}) {
  return (
    <ul className="plain ap-list">
      {items.map(({ finding, dismissal }) => (
        <li key={finding.id} className="ap-item">
          <div className="ap-row still">
            <span className={`ap-sev sev-${finding.severity}`}>{severityWord(finding.severity)}</span>
            <div className="ap-row-main">
              <span className="title ap-row-title whole">{finding.title}</span>
              <span className="muted">{dismissReasonWord(dismissal.reason)}</span>
              {dismissal.text !== '' && <p>{dismissal.text}</p>}
            </div>
            <button type="button" className="btn small" disabled={!canRestore} onClick={() => onRestore(dismissal)} aria-label={`Restore ${finding.title}`}>Restore</button>
          </div>
        </li>
      ))}
    </ul>
  );
}
