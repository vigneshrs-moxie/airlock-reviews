import { useEffect, useRef } from 'react';
import { useAnnounce } from './Frame';
import type { PanelState, StageLine } from '../state/reduce';
import { BriefBlock } from './BriefBlock';
import { MapBlock } from './MapBlock';

const STATUS_WORDS: Record<StageLine['status'], string> = { working: 'Working', done: 'Done', failed: 'Failed', skipped: 'Skipped' };

/** The sentence for the frame's live region: the lines whose status changed since the last render. */
function useAnnouncement(stages: StageLine[]): void {
  const seen = useRef(new Map<string, StageLine['status']>());
  const announce = useAnnounce();
  useEffect(() => {
    const changed = stages.filter((s) => seen.current.get(s.stage) !== s.status);
    const first = seen.current.size === 0;
    seen.current = new Map(stages.map((s) => [s.stage, s.status]));
    if (changed.length > 0 && !first) announce(changed.map((s) => `${s.words}: ${STATUS_WORDS[s.status]}`).join('. '));
  }, [stages, announce]);
}

export function Running({ state }: { state: Extract<PanelState, { kind: 'running' }> }) {
  useAnnouncement(state.stages);
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
      </section>
      {state.brief !== null && <BriefBlock brief={state.brief} />}
      {state.map !== null && <MapBlock map={state.map} />}
    </>
  );
}
