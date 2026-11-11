import { useEffect, useRef, useState } from 'react';
import type { PanelState, StageLine } from '../state/reduce';
import { BriefBlock } from './BriefBlock';
import { MapBlock } from './MapBlock';

const STATUS_WORDS: Record<StageLine['status'], string> = { working: 'Working', done: 'Done', failed: 'Failed', skipped: 'Skipped' };

/** The sentence for the one live region: the lines whose status changed since the last render. */
function useAnnouncement(stages: StageLine[]): string {
  const seen = useRef(new Map<string, StageLine['status']>());
  const [said, setSaid] = useState('');
  useEffect(() => {
    const changed = stages.filter((s) => seen.current.get(s.stage) !== s.status);
    const first = seen.current.size === 0;
    seen.current = new Map(stages.map((s) => [s.stage, s.status]));
    if (changed.length > 0 && !first) setSaid(changed.map((s) => `${s.words}: ${STATUS_WORDS[s.status]}`).join('. '));
  }, [stages]);
  return said;
}

export function Running({ state }: { state: Extract<PanelState, { kind: 'running' }> }) {
  const said = useAnnouncement(state.stages);
  return (
    <>
      <section className="card">
        <h2 className="title">Reviewing</h2>
        <ul className="plain stages" aria-label="Stages">
          {state.stages.map((s) => (
            <li key={s.stage} className="stage" data-status={s.status}>
              <span className="word">{STATUS_WORDS[s.status]}</span>
              <span>
                {s.words}
                {s.status === 'failed' && s.detail !== '' && <span className="detail block">{s.detail}</span>}
              </span>
            </li>
          ))}
        </ul>
        <div aria-live="polite" className="sr-only">{said}</div>
      </section>
      {state.brief !== null && <BriefBlock brief={state.brief} />}
      {state.map !== null && <MapBlock map={state.map} />}
    </>
  );
}
