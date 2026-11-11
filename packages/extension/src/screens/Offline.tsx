import type { Timers } from '../client/timers';
import type { PanelState } from '../state/reduce';
import { BriefBlock } from './BriefBlock';
import { CommandBox } from './CommandBox';
import { MapBlock } from './MapBlock';

export function Offline({ state, timers }: { state: Extract<PanelState, { kind: 'offline' }>; timers?: Timers }) {
  const { progress, review } = state;
  return (
    <>
      <section className="card alert">
        <h2 className="title">Airlock's service on this Mac is not running.</h2>
        <CommandBox intro="In the airlock-reviews folder, run:" command="npm run service" {...(timers ? { timers } : {})} />
        <p className="muted">Airlock checks again every few seconds.</p>
      </section>
      {review !== undefined && <p className="muted">Your last review is kept and will come back when the service does.</p>}
      {progress?.brief != null && <BriefBlock brief={progress.brief} />}
      {progress?.map != null && <MapBlock map={progress.map} />}
    </>
  );
}
