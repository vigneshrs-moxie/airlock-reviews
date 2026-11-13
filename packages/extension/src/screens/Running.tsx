import { useEffect, useId, useRef, useState } from 'react';
import { useAnnounce } from './Frame';
import type { PanelState, StageLine } from '../state/reduce';
import { BriefBlock, briefPoints } from './BriefBlock';
import { Collapsible } from './Collapsible';
import { MapBlock } from './MapBlock';
import { elapsedWords, filesAndGroups, progressOf, stepWords, type StepRow } from './progress';

const STATUS_WORDS: Record<StageLine['status'], string> = { working: 'Working', done: 'Done', failed: 'Failed', skipped: 'Skipped' };
/** The colour beside each step's word: a second cue only. */
const ROW_TONE: Record<StepRow['word'], string> = { Done: 'sev-ok', Now: 'sev-ask', Next: 'sev-note', Failed: 'sev-block', Skipped: 'sev-note' };
/** The title before the first stage is reported. */
const STARTING = 'Starting the review';

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

/** Time since this screen appeared (when the panel started the review, or attached to it), counted each second. */
function useElapsed(): number {
  const [since] = useState(() => Date.now());
  const [now, setNow] = useState(since);
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);
  return now - since;
}

/**
 * The progress screen: the stage now, a progress bar with its step in words, one quiet line, every step in a fold, and
 * what the review has found so far (the brief and the map, as they arrive) in another.
 */
export function Running({ state }: { state: Extract<PanelState, { kind: 'running' }> }) {
  useAnnouncement(state.stages);
  const elapsed = useElapsed();
  const headingId = useId();
  const [stepsOpen, setStepsOpen] = useState(false);
  const [foundOpen, setFoundOpen] = useState(false);
  const progress = progressOf(state.stages, state.depth);
  const { step, total } = progress;
  const known = total !== null && step > 0;
  const words = step === 0 ? null : stepWords(progress);
  const brief = state.brief !== null && briefPoints(state.brief) > 0 ? state.brief : null;
  const files = filesAndGroups(state.map);
  // A map with no file in it (a sync merge's) has nothing to show.
  const map = files === null ? null : state.map;
  const quiet = [words, elapsedWords(elapsed), files].filter((part) => part !== null).join(' · ');
  return (
    <>
      <section className="card ap-lead" aria-labelledby={headingId}>
        <h2 className="label" id={headingId}>Reviewing</h2>
        <p className="ap-title">{progress.current ?? STARTING}</p>
        <div
          role="progressbar" aria-label="Progress" className={known ? 'ap-progress' : 'ap-progress unknown'}
          {...(known ? { 'aria-valuemin': 0, 'aria-valuemax': total, 'aria-valuenow': step } : {})}
          aria-valuetext={words ?? STARTING}
        >
          {known && <i style={{ width: `${Math.min(100, (step / total) * 100)}%` }} />}
        </div>
        <p className="muted">{quiet}</p>
      </section>
      <Collapsible title="Show the steps" count={String(progress.rows.length)} open={stepsOpen} onToggle={() => setStepsOpen(!stepsOpen)}>
        <ul className="plain ap-steps-list" aria-label="Stages">
          {progress.rows.map((row) => (
            <li key={row.stage} className="ap-step" data-status={row.word.toLowerCase()}>
              <span className={`ap-sev ${ROW_TONE[row.word]}`}>{row.word}</span>
              <span className="ap-step-words">
                {row.words}
                {row.detail !== '' && <span className="detail block">{row.detail}</span>}
              </span>
            </li>
          ))}
        </ul>
      </Collapsible>
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
