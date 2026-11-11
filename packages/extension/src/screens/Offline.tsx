import type { Timers } from '../client/timers';
import type { PanelState, Progress } from '../state/reduce';
import { BriefBlock } from './BriefBlock';
import { CommandBox } from './CommandBox';
import { MapBlock } from './MapBlock';

/**
 * The card that says the service is not running. It sits above what was on screen before, which the panel screen keeps
 * drawing in its own place, so that screen's state (an open finding, ticks, choices) survives the flip.
 */
export function OfflineCard({ state, timers }: { state: Extract<PanelState, { kind: 'offline' }>; timers?: Timers }) {
  const t = timers ? { timers } : {};
  return (
    <>
      <section className="card alert">
        <h2 className="title">Airlock's service on this Mac is not running.</h2>
        <CommandBox intro="In the airlock-reviews folder, run:" command="npm run service" {...t} />
        <p className="muted">Airlock checks again every few seconds.</p>
      </section>
      {state.review !== undefined && <p className="muted">Shown from before the service stopped.</p>}
    </>
  );
}

/** What a running review had shown when the service stopped answering. */
export function KeptProgress({ progress }: { progress: Progress | undefined }) {
  return (
    <>
      {progress?.brief != null && <BriefBlock brief={progress.brief} />}
      {progress?.map != null && <MapBlock map={progress.map} />}
    </>
  );
}
