import { useState } from 'react';
import type { Timers } from '../client/timers';
import type { PanelState, Progress } from '../state/reduce';
import { BriefBlock, briefPoints } from './BriefBlock';
import { Collapsible } from './Collapsible';
import { CommandBox } from './CommandBox';
import { MapBlock } from './MapBlock';
import { filesAndGroups } from './progress';

/**
 * The card that says the service is not running. It sits above what was on screen before, which the panel screen keeps
 * drawing in its own place, so that screen's state (an open finding, ticks, choices) survives the flip.
 */
export function OfflineCard({ state, timers }: { state: Extract<PanelState, { kind: 'offline' }>; timers?: Timers }) {
  const t = timers ? { timers } : {};
  return (
    <>
      <section className="card alert ap-lead">
        <h2 className="title">Airlock's service on this Mac is not running.</h2>
        <CommandBox intro="In the airlock-reviews folder, run:" command="npm run service" {...t} />
        <p className="muted">Airlock checks again every few seconds.</p>
      </section>
      {(state.review !== undefined || state.progress !== undefined) && <p className="muted">Shown from before the service stopped.</p>}
    </>
  );
}

/**
 * What a running review had shown when the service stopped answering, as the progress screen shows it: its lead card
 * (Reviewing, and the step it was on in words), then what it had found so far (the brief and the map) in a fold.
 */
export function KeptProgress({ progress }: { progress: Progress | undefined }) {
  const [foundOpen, setFoundOpen] = useState(false);
  if (progress === undefined) return null;
  const brief = progress.brief !== null && briefPoints(progress.brief) > 0 ? progress.brief : null;
  const map = filesAndGroups(progress.map) === null ? null : progress.map;
  return (
    <>
      <section className="card ap-lead">
        <h2 className="label">Reviewing</h2>
        <p className="ap-title">{progress.current ?? 'Starting the review'}</p>
      </section>
      {(brief !== null || map !== null) && (
        <Collapsible title="What it has found so far" open={foundOpen} onToggle={() => setFoundOpen(!foundOpen)}>
          {brief !== null && (
            <div className="ap-part">
              {brief.whatItDoes.length > 0 && <h4 className="label">What this does</h4>}
              <BriefBlock brief={brief} nested />
            </div>
          )}
          {map !== null && <MapBlock map={map} nested />}
        </Collapsible>
      )}
    </>
  );
}
