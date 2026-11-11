import type { PanelState, UserAction } from '../state/reduce';
import { Frame, connectionOf } from './Frame';
import { Offline } from './Offline';
import { Pair } from './Pair';
import { Problem } from './Problem';
import { Ready } from './Ready';
import { ReviewPlaceholder } from './ReviewPlaceholder';
import { Running } from './Running';

export interface PanelScreenProps {
  state: PanelState;
  dispatch: (action: UserAction) => void;
  onOpenPacks: () => void;
}

function Body({ state, dispatch }: Pick<PanelScreenProps, 'state' | 'dispatch'>) {
  switch (state.kind) {
    case 'loading': return <p className="muted">Looking at this pull request…</p>;
    case 'no-pr': return <p className="muted">Open a pull request on GitHub and Airlock will appear here.</p>;
    case 'offline': return <Offline state={state} />;
    case 'unpaired': return <Pair state={state} dispatch={dispatch} />;
    // Keyed so a different pull request or a new head starts with its own choices.
    case 'ready': return <Ready key={`${state.pr.repo}#${state.pr.number}@${state.pr.headSha}`} state={state} dispatch={dispatch} />;
    case 'running': return <Running state={state} />;
    case 'problem': return <Problem state={state} dispatch={dispatch} />;
    case 'review': return <ReviewPlaceholder state={state} dispatch={dispatch} />;
  }
}

/** The frame and the screen for one state. */
export function PanelScreen({ state, dispatch, onOpenPacks }: PanelScreenProps) {
  return (
    <Frame status={connectionOf(state)} onOpenPacks={onOpenPacks}>
      <Body state={state} dispatch={dispatch} />
    </Frame>
  );
}
