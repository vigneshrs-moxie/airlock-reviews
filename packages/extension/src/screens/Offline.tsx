import type { Finding } from '@airlock/shared';
import type { Timers } from '../client/timers';
import type { PanelState, UserAction } from '../state/reduce';
import { BriefBlock } from './BriefBlock';
import { CommandBox } from './CommandBox';
import type { Jump } from '../state/jump';
import { MapBlock } from './MapBlock';
import { Verdict } from './Verdict';

export function Offline({ state, dispatch, timers, onJump, onDismiss }: {
  state: Extract<PanelState, { kind: 'offline' }>;
  dispatch: (action: UserAction) => void;
  timers?: Timers;
  onJump?: Jump;
  onDismiss?: (finding: Finding) => void;
}) {
  const { progress, review } = state;
  const t = timers ? { timers } : {};
  return (
    <>
      <section className="card alert">
        <h2 className="title">Airlock's service on this Mac is not running.</h2>
        <CommandBox intro="In the airlock-reviews folder, run:" command="npm run service" {...t} />
        <p className="muted">Airlock checks again every few seconds.</p>
      </section>
      {review !== undefined && (
        <>
          <p className="muted">Shown from before the service stopped.</p>
          <Verdict
            key={review.latest.document.id} state={review} dispatch={dispatch} readOnly
            {...(onJump ? { onJump } : {})} {...(onDismiss ? { onDismiss } : {})} {...t}
          />
        </>
      )}
      {review === undefined && progress?.brief != null && <BriefBlock brief={progress.brief} />}
      {review === undefined && progress?.map != null && <MapBlock map={progress.map} />}
    </>
  );
}
