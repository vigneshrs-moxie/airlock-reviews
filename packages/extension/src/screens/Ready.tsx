import type { Depth, PrSummary, Stage } from '@airlock/shared';
import { useId, useState } from 'react';
import type { PanelState, UserAction } from '../state/reduce';
import { ChevronRight } from './Frame';
import { Pinned } from './Pinned';
import { prLine } from './progress';

export function stageWordsFor(pr: Pick<PrSummary, 'stage' | 'isOwn'>): string {
  const words: Record<Stage, string> = {
    pr1: pr.isOwn ? "Your pull request, first stage: your branch into the team's branch." : "A pull request into the team's branch.",
    pr2: "Second stage: the team's branch into staging.",
    pr3: 'Third stage: staging into production.',
    other: 'A pull request outside the three stages.',
  };
  return words[pr.stage];
}

const DEPTHS: { depth: Depth; name: string; line: string }[] = [
  { depth: 'quick', name: 'Quick', line: 'One pass, no second opinion. For small changes.' },
  { depth: 'standard', name: 'Standard', line: 'Every finding is challenged before you see it.' },
  { depth: 'deep', name: 'Deep', line: 'Standard, plus a closer second pass over each layer.' },
];

const START_LABEL = 'Review this pull request';
const START_NOTE = 'Runs on your Claude login. Nothing is posted to GitHub.';
const ONE_PACK_STAYS = 'At least one pack stays on.';

/**
 * The start screen: the pull request, the depth, the packs (folded under one row) and, pinned to the bottom, the button
 * that starts the review.
 */
export function Ready({ state, dispatch, defaultDepth = null, offline = false }: {
  state: Extract<PanelState, { kind: 'ready' }>;
  dispatch: (a: UserAction) => void;
  /** The default depth stored in Settings, when there is one; the pull request's suggestion otherwise. */
  defaultDepth?: Depth | null;
  /** Kept from before the service stopped: the choices stay, and Review waits for the service. */
  offline?: boolean;
}) {
  const { pr } = state;
  // What the person picked here wins; then the stored default (which may arrive after the screen); then the suggestion.
  const [picked, setDepth] = useState<Depth | null>(null);
  const depth = picked ?? defaultDepth ?? pr.suggestedDepth;
  const [off, setOff] = useState<ReadonlySet<string>>(new Set());
  const [packsOpen, setPacksOpen] = useState(false);
  const ids = { title: useId(), depth: useId(), depthLine: useId(), packs: useId(), packsLine: useId(), packsFold: useId(), hint: useId(), note: useId() };
  const group = useId();
  const busy = state.busy === true;
  const on = pr.packs.filter((p) => !off.has(p.id));
  const chosen = DEPTHS.find((d) => d.depth === depth);

  const toggle = (id: string): void => {
    const next = new Set(off);
    if (next.has(id)) next.delete(id);
    else if (on.length > 1) next.add(id);
    setOff(next);
  };
  const start = (): void => {
    dispatch(off.size === 0 ? { type: 'start', depth } : { type: 'start', depth, packIds: on.map((p) => p.id) });
  };

  return (
    <>
      <section className="card ap-lead" aria-labelledby={ids.title}>
        <p className="label">Pull request</p>
        <h2 className="ap-title" id={ids.title}>{pr.title}</h2>
        <p className="muted">{prLine(pr)}</p>
        <p className="muted">{stageWordsFor(pr)}</p>
      </section>
      <section className="ap-group" aria-labelledby={ids.depth}>
        <h2 className="label" id={ids.depth}>Depth</h2>
        <div className="ap-seg" role="radiogroup" aria-labelledby={ids.depth} {...(chosen ? { 'aria-describedby': ids.depthLine } : {})}>
          {DEPTHS.map((d) => (
            <label key={d.depth} className={depth === d.depth ? 'on' : undefined}>
              <input type="radio" name={group} value={d.depth} checked={depth === d.depth} onChange={() => setDepth(d.depth)} disabled={busy} />
              <span>{d.name}</span>
            </label>
          ))}
        </div>
        {chosen && <p className="muted" id={ids.depthLine}>{chosen.line}</p>}
      </section>
      <section className="ap-start-packs">
        <h2 className="ap-fold-head">
          <button
            type="button" className="ap-set" aria-expanded={packsOpen} {...(packsOpen ? { 'aria-controls': ids.packsFold } : {})}
            aria-labelledby={ids.packs} aria-describedby={ids.packsLine} onClick={() => setPacksOpen(!packsOpen)}
          >
            <span className="grow">
              <b id={ids.packs}>Packs</b>
              <span className="muted" id={ids.packsLine}>{on.length === 0 ? 'None' : on.map((p) => p.title).join(', ')}</span>
            </span>
            <span className="ap-go"><ChevronRight /></span>
          </button>
        </h2>
        {packsOpen && (
          <ul className="plain ap-start-pack-list" id={ids.packsFold}>
            {pr.packs.map((p) => {
              const last = !off.has(p.id) && on.length === 1;
              return (
                <li key={p.id}>
                  <label className="ap-set">
                    <span className="grow">
                      <b id={`${ids.packs}-${p.id}`}>{p.title}</b>
                      {last && <span className="muted" id={ids.hint}>{ONE_PACK_STAYS}</span>}
                    </span>
                    <input
                      type="checkbox" role="switch" className="ap-switch" aria-labelledby={`${ids.packs}-${p.id}`}
                      checked={!off.has(p.id)} onChange={() => toggle(p.id)} disabled={busy || last}
                      {...(last ? { 'aria-describedby': ids.hint } : {})}
                    />
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <Pinned name="start" label="Start the review" above={state.notice !== undefined && <p role="alert" className="notice">{state.notice}</p>}>
        <div className="ap-start-go">
          <button type="button" className="btn primary wide" disabled={busy || offline} onClick={start} aria-describedby={ids.note}>{START_LABEL}</button>
          <p className="muted" id={ids.note}>{START_NOTE}</p>
        </div>
      </Pinned>
    </>
  );
}
