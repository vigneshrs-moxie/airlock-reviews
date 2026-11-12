import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode, type Ref } from 'react';
import { realTimers, type Timers } from '../client/timers';
import type { PanelState } from '../state/reduce';

export type Connection = 'Connected' | 'Checking…' | 'Not running' | 'Not paired' | 'Problem';

/** What the state proves about the connection; null when it proves nothing (no pull request to look at). */
export function connectionOf(state: PanelState): Connection | null {
  switch (state.kind) {
    case 'loading': return 'Checking…';
    case 'no-pr': return null;
    case 'offline': return 'Not running';
    case 'unpaired': return 'Not paired';
    case 'problem': return 'Problem';
    case 'ready': case 'running': case 'review': return 'Connected';
  }
}

const Announce = createContext<(text: string) => void>(() => undefined);

/** Screens say a change to the one live region the frame holds. */
export const useAnnounce = (): ((text: string) => void) => useContext(Announce);

/** The head every screen sits under: the name, the connection in one word, the Packs button and the live region. */
export function Frame({ status, onOpenPacks, packsRef, timers = realTimers, children }: {
  status: Connection | null; onOpenPacks: () => void; packsRef?: Ref<HTMLButtonElement>; timers?: Timers; children: ReactNode;
}) {
  const [said, setSaid] = useState('');
  const current = useRef('');
  const pending = useRef<unknown>(null);
  useEffect(() => () => { if (pending.current !== null) timers.clearTimeout(pending.current); }, [timers]);
  // The same sentence twice is announced twice: the region is emptied first and the sentence set again on the next tick.
  const announce = useCallback((text: string): void => {
    if (pending.current !== null) { timers.clearTimeout(pending.current); pending.current = null; }
    const set = (value: string): void => { current.current = value; setSaid(value); };
    if (text !== current.current) { set(text); return; }
    set('');
    pending.current = timers.setTimeout(() => { pending.current = null; set(text); }, 0);
  }, [timers]);
  return (
    <Announce.Provider value={announce}>
      <div className="panel">
        <header className="head">
          {/* The mark is a background, not an image element: the panel holds no img, so text from a review can never be one. */}
          <span className="mark" aria-hidden="true" />
          <h1 className="name">Airlock</h1>
          {status !== null && <span className="status" data-status={status}>{status}</span>}
          <button type="button" className="btn small packs" ref={packsRef} onClick={onOpenPacks}>Packs</button>
        </header>
        <main className="body" tabIndex={-1}>{children}</main>
        <div aria-live="polite" className="sr-only">{said}</div>
      </div>
    </Announce.Provider>
  );
}
