import type { Timers } from '../client/timers';
import type { PanelState, UserAction } from '../state/reduce';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Frame, connectionOf, useAnnounce } from './Frame';
import { Offline } from './Offline';
import { Pair } from './Pair';
import { Problem } from './Problem';
import { Ready } from './Ready';
import { Running } from './Running';
import { Verdict } from './Verdict';
import type { OnJump } from './FindingDetail';
import type { Depth, Finding, PackRef, PrSummary, ServiceStatus } from '@airlock/shared';
import { DismissSheet } from './DismissSheet';
import { Packs } from './Packs';

export interface PanelScreenProps {
  state: PanelState;
  dispatch: (action: UserAction) => void;
  /** Called when the Packs button is pressed; the Packs screen opens either way. */
  onOpenPacks?: () => void;
  /** For the Copy buttons' two seconds; the real clock unless a test passes its own. */
  timers?: Timers;
  /** Takes the person to a line on the GitHub page; until a later task supplies it, it says it is not connected. */
  onJump?: OnJump;
  /** Asks the service for its status, for the Packs screen. */
  fetchStatus?: () => Promise<ServiceStatus>;
  /** The depth stored in the Packs screen; null when none is stored. */
  defaultDepth?: Depth | null;
  /** Stores the default depth; null clears it. */
  onDefaultDepth?: (depth: Depth | null) => void;
}

const unreachable = (): Promise<ServiceStatus> => Promise.reject(new Error('no service'));

/** The pull request and the review's packs the state knows about, kept readable even offline. */
function knownOf(state: PanelState): { pr: PrSummary | null; packs: readonly PackRef[] } {
  switch (state.kind) {
    case 'ready': case 'running': case 'problem': return { pr: state.pr, packs: [] };
    case 'review': return { pr: state.pr, packs: state.latest.document.packs };
    case 'offline':
      if (state.review !== undefined) return { pr: state.review.pr, packs: state.review.latest.document.packs };
      return { pr: state.progress?.pr ?? null, packs: [] };
    default: return { pr: null, packs: [] };
  }
}

function Body({ state, dispatch, timers, onJump, onDismiss, defaultDepth }: Pick<PanelScreenProps, 'state' | 'dispatch' | 'timers' | 'onJump' | 'defaultDepth'> & { onDismiss: (finding: Finding) => void }) {
  const t = timers ? { timers } : {};
  const review = { ...(onJump ? { onJump } : {}), onDismiss };
  switch (state.kind) {
    case 'loading': return <p className="muted">Looking at this pull request…</p>;
    case 'no-pr': return <p className="muted">Open a pull request on GitHub and Airlock will appear here.</p>;
    case 'offline': return <Offline state={state} dispatch={dispatch} {...t} {...review} />;
    case 'unpaired': return <Pair state={state} dispatch={dispatch} {...t} />;
    // Keyed so a different pull request or a new head starts with its own choices.
    case 'ready': return <Ready key={`${state.pr.repo}#${state.pr.number}@${state.pr.headSha}`} state={state} dispatch={dispatch} defaultDepth={defaultDepth ?? null} />;
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

/** The frame and the screen for one state, with the Packs screen and the dismiss sheet over it. */
export function PanelScreen({ state, dispatch, onOpenPacks, timers, onJump, fetchStatus = unreachable, defaultDepth = null, onDefaultDepth }: PanelScreenProps) {
  const [packsOpen, setPacksOpen] = useState(false);
  const [dismissing, setDismissing] = useState<Finding | null>(null);
  const packsButton = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  // Back returns focus to the button that opened the screen.
  useEffect(() => {
    if (packsOpen) wasOpen.current = true;
    else if (wasOpen.current) { wasOpen.current = false; packsButton.current?.focus(); }
  }, [packsOpen]);
  const closeDismiss = useCallback((): void => setDismissing(null), []);
  const known = knownOf(state);
  return (
    <Frame
      status={connectionOf(state)} packsRef={packsButton} {...(timers ? { timers } : {})}
      onOpenPacks={() => { setPacksOpen(true); onOpenPacks?.(); }}
    >
      <FinishedAnnouncer kind={state.kind} />
      {packsOpen ? (
        <Packs
          pr={known.pr} packVersions={known.packs} paired={state.kind !== 'unpaired'} fetchStatus={fetchStatus}
          defaultDepth={defaultDepth} onDefaultDepth={onDefaultDepth ?? (() => undefined)} onBack={() => setPacksOpen(false)}
          {...(timers ? { timers } : {})}
        />
      ) : (
        <>
          <Body state={state} dispatch={dispatch} timers={timers} onJump={onJump} onDismiss={setDismissing} defaultDepth={defaultDepth} />
          {dismissing !== null && state.kind === 'review' && (
            <DismissSheet state={state} finding={dismissing} dispatch={dispatch} onClose={closeDismiss} />
          )}
        </>
      )}
    </Frame>
  );
}
