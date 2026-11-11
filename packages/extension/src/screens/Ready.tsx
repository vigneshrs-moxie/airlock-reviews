import type { Depth, PrSummary, Stage } from '@airlock/shared';
import { useId, useState } from 'react';
import type { PanelState, UserAction } from '../state/reduce';

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

export function Ready({ state, dispatch, defaultDepth = null }: {
  state: Extract<PanelState, { kind: 'ready' }>;
  dispatch: (a: UserAction) => void;
  /** The depth stored in the Packs screen, when there is one; the pull request's suggestion otherwise. */
  defaultDepth?: Depth | null;
}) {
  const { pr } = state;
  // What the person picked here wins; then the stored default (which may arrive after the screen); then the suggestion.
  const [picked, setDepth] = useState<Depth | null>(null);
  const depth = picked ?? defaultDepth ?? pr.suggestedDepth;
  const [off, setOff] = useState<ReadonlySet<string>>(new Set());
  const group = useId();
  const hintId = useId();
  const busy = state.busy === true;
  const on = pr.packs.filter((p) => !off.has(p.id));

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
      <section className="card">
        <h2 className="title">{pr.title}</h2>
        <p>{stageWordsFor(pr)}</p>
        <p className="muted">{`${pr.changedFiles} files, ${pr.additions + pr.deletions} changed lines`}</p>
      </section>
      <section className="card">
        <h2 className="label">Packs</h2>
        <ul className="plain">
          {pr.packs.map((p) => (
            <li key={p.id} className="row">
              <label className="switch">
                <input
                  type="checkbox" role="switch" checked={!off.has(p.id)} onChange={() => toggle(p.id)}
                  disabled={busy || (!off.has(p.id) && on.length === 1)}
                  {...(!off.has(p.id) && on.length === 1 ? { 'aria-describedby': hintId } : {})}
                />
                <span>{p.title}</span>
              </label>
              {!off.has(p.id) && on.length === 1 && <p id={hintId} className="muted">At least one pack stays on.</p>}
            </li>
          ))}
        </ul>
      </section>
      <fieldset className="card">
        <legend className="label">Depth</legend>
        {DEPTHS.map((d) => (
          <label key={d.depth} className="choice">
            <input type="radio" name={group} value={d.depth} checked={depth === d.depth} onChange={() => setDepth(d.depth)} disabled={busy} />
            <span><strong>{d.name}</strong><span className="muted block">{d.line}</span></span>
          </label>
        ))}
      </fieldset>
      <button type="button" className="btn primary wide" disabled={busy} onClick={start}>Review</button>
      {state.notice !== undefined && <p role="alert" className="notice">{state.notice}</p>}
    </>
  );
}
