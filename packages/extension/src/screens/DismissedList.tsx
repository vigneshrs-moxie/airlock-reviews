import type { Dismissal } from '@airlock/shared';
import type { DismissedFinding } from '../state/selection';
import { dismissReasonWord } from './words';

/** Findings the person dismissed: the reason, the text they saved and a Restore button. */
export function DismissedList({ items, canRestore, onRestore }: {
  items: readonly DismissedFinding[];
  canRestore: boolean;
  onRestore: (dismissal: Dismissal) => void;
}) {
  return (
    <ul className="plain">
      {items.map(({ finding, dismissal }) => (
        <li key={finding.id}>
          <div className="title">{finding.title}</div>
          <div className="muted">{dismissReasonWord(dismissal.reason)}</div>
          {dismissal.text !== '' && <p>{dismissal.text}</p>}
          <button type="button" className="btn small" disabled={!canRestore} onClick={() => onRestore(dismissal)} aria-label={`Restore ${finding.title}`}>Restore</button>
        </li>
      ))}
    </ul>
  );
}
