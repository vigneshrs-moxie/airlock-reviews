import type { Timers } from '../client/timers';
import type { PanelState, UserAction } from '../state/reduce';
import { useEffect, useRef } from 'react';
import { Frame, connectionOf, useAnnounce } from './Frame';
import { Offline } from './Offline';
import { Pair } from './Pair';
import { Problem } from './Problem';
import { Ready } from './Ready';
import { Running } from './Running';
import { Verdict } from './Verdict';
import type { OnJump } from './FindingDetail';
import type { Finding } from '@airlock/shared';

export interface PanelScreenProps {
  state: PanelState;
  dispatch: (action: UserAction) => void;
  onOpenPacks: () => void;
  /** For the Copy buttons' two seconds; the real clock unless a test passes its own. */
  timers?: Timers;
  /** Takes the person to a line on the GitHub page; until a later task supplies it, it says it is not connected. */
  onJump?: OnJump;
  /** Starts dismissing a finding; until a later task supplies it, it does nothing. */
  onDismiss?: (finding: Finding) => void;
}

function Body({ state, dispatch, timers, onJump, onDismiss }: Omit<PanelScreenProps, 'onOpenPacks'>) {
  const t = timers ? { timers } : {};
  const review = { ...(onJump ? { onJump } : {}), ...(onDismiss ? { onDismiss } : {}) };
  switch (state.kind) {
    case 'loading': return <p className="muted">Looking at this pull request…</p>;
    case 'no-pr': return <p className="muted">Open a pull request on GitHub and Airlock will appear here.</p>;
    case 'offline': return <Offline state={state} dispatch={dispatch} {...t} {...review} />;
    case 'unpaired': return <Pair state={state} dispatch={dispatch} {...t} />;
    // Keyed so a different pull request or a new head starts with its own choices.
    case 'ready': return <Ready key={`${state.pr.repo}#${state.pr.number}@${state.pr.headSha}`} state={state} dispatch={dispatch} />;
    case 'running': return <Running state={state} />;
    case 'problem': return <Problem state={state} dispatch={dispatch} />;
    // Keyed so a new review starts with nothing selected and nothing open.
    case 'review': return <Verdict key={state.latest.document.id} state={state} dispatch={dispatch} {...t} {...review} />;
  }
}

/** Says a review has finished, once, when the panel moves from a running review to the finished one. */
function FinishedAnnouncer({ kind }: { kind: PanelState['kind'] }) {
  const announce = useAnnounce();
  const was = useRef(kind);
  useEffect(() => {
    if (was.current === 'running' && kind === 'review') announce('Review finished.');
    was.current = kind;
  }, [announce, kind]);
  return null;
}

/** The frame and the screen for one state. */
export function PanelScreen({ state, dispatch, onOpenPacks, timers, onJump, onDismiss }: PanelScreenProps) {
  return (
    <Frame status={connectionOf(state)} onOpenPacks={onOpenPacks}>
      <FinishedAnnouncer kind={state.kind} />
      <Body state={state} dispatch={dispatch} timers={timers} onJump={onJump} onDismiss={onDismiss} />
    </Frame>
  );
}
