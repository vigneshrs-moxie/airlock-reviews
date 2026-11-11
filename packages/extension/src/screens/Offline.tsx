import type { PanelState } from '../state/reduce';
import { BriefBlock } from './BriefBlock';
import { CommandBox } from './CommandBox';
import { MapBlock } from './MapBlock';

export function Offline({ state }: { state: Extract<PanelState, { kind: 'offline' }> }) {
  const { progress, review } = state;
  return (
    <>
      <section className="card alert">
        <h2 className="title">Airlock's service on this Mac is not running.</h2>
        <p className="label">Start it</p>
        <p>In the airlock-reviews folder, run:</p>
        <CommandBox command="npm run service" label="Command to start the service" />
        <p className="muted">Airlock checks again every few seconds.</p>
      </section>
      {review !== undefined && <p className="muted">Your last review is kept and will come back when the service does.</p>}
      {progress?.brief != null && <BriefBlock brief={progress.brief} />}
      {progress?.map != null && <MapBlock map={progress.map} />}
    </>
  );
}
