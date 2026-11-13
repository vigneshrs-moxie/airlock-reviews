import type { PanelState, UserAction } from '../state/reduce';
import { BriefBlock } from './BriefBlock';
import { MapBlock } from './MapBlock';

export function Problem({ state, dispatch }: { state: Extract<PanelState, { kind: 'problem' }>; dispatch: (a: UserAction) => void }) {
  return (
    <>
      <section className="card alert ap-lead">
        <p role="alert">{state.message}</p>
        <button type="button" className="btn primary ap-main" onClick={() => dispatch({ type: 'retry' })}>Retry</button>
      </section>
      {state.brief !== undefined && <BriefBlock brief={state.brief} />}
      {state.map !== undefined && <MapBlock map={state.map} />}
    </>
  );
}
