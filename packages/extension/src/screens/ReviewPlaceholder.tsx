// A stand-in for the finished-review screens; the next task replaces this file.
import { useEffect } from 'react';
import type { PanelState, UserAction } from '../state/reduce';
import { useAnnounce } from './Frame';

export function ReviewPlaceholder({ state, dispatch }: { state: Extract<PanelState, { kind: 'review' }>; dispatch: (a: UserAction) => void }) {
  const announce = useAnnounce();
  useEffect(() => announce('Review finished.'), [announce]);
  return (
    <section className="card">
      <h2 className="title">{state.pr.title}</h2>
      <p>Review finished.</p>
      <button type="button" className="btn" disabled={state.busy === true} onClick={() => dispatch({ type: 'start', depth: state.pr.suggestedDepth })}>Review again</button>
    </section>
  );
}
