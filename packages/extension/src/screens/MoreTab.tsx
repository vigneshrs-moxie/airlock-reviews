import type { Dismissal, ReviewDocument } from '@airlock/shared';
import type { ReactNode, Ref } from 'react';
import type { DismissedFinding } from '../state/selection';
import { Collapsible } from './Collapsible';
import { DismissedList } from './DismissedList';
import { reviewTime, TimingTable, tookTime } from './TimingTable';
import { depthWord } from './words';

export type MoreFold = 'dismissed' | 'timing';

/**
 * The More tab: when, how deep, how long and with which packs it was reviewed; Review again; then folds with counts, each
 * left out when empty: the dismissed findings with Restore, and the timing; and the button that opens what was dropped.
 * What the reviewer was not shown and the review's notes are not here: they stay in sight above the tabs.
 */
export function MoreTab({ doc, packTitles, reviewAgain, dismissed, canRestore, onRestore, folds, onFold, droppedRef, onDropped }: {
  doc: ReviewDocument;
  packTitles: string;
  /** Review again, or nothing when the stale banner already offers it. */
  reviewAgain: ReactNode;
  dismissed: readonly DismissedFinding[];
  canRestore: boolean;
  onRestore: (dismissal: Dismissal) => void;
  folds: ReadonlySet<string>;
  onFold: (key: MoreFold) => void;
  droppedRef: Ref<HTMLButtonElement>;
  onDropped: () => void;
}) {
  const fold = (key: MoreFold) => ({ open: folds.has(key), onToggle: () => onFold(key) });
  const took = reviewTime(doc);
  const stages = doc.timings.filter(tookTime).length;
  return (
    <>
      <p className="muted">{`Reviewed at ${doc.pr.headSha.slice(0, 7)} · ${depthWord(doc.depth)} depth${took === null ? '' : ` · ${took}`}${packTitles === '' ? '' : ` · Packs: ${packTitles}`}`}</p>
      {reviewAgain}
      {dismissed.length > 0 && (
        <Collapsible title="Dismissed" count={String(dismissed.length)} name="dismissed" {...fold('dismissed')}>
          <DismissedList items={dismissed} canRestore={canRestore} onRestore={onRestore} />
        </Collapsible>
      )}
      {stages > 0 && (
        <Collapsible title="Timing" count={`${stages} ${stages === 1 ? 'step' : 'steps'}`} {...fold('timing')}>
          <TimingTable timings={doc.timings} />
        </Collapsible>
      )}
      {doc.dropped.length > 0 && (
        <button type="button" className="btn ap-start" ref={droppedRef} onClick={onDropped}>{`Dropped: ${doc.dropped.length}`}</button>
      )}
    </>
  );
}
