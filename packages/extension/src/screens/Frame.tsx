import { createContext, useContext, useState, type ReactNode } from 'react';
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
export function Frame({ status, onOpenPacks, children }: { status: Connection | null; onOpenPacks: () => void; children: ReactNode }) {
  const [said, setSaid] = useState('');
  return (
    <Announce.Provider value={setSaid}>
      <div className="panel">
        <header className="head">
          <h1 className="name">Airlock</h1>
          {status !== null && <span className="status" data-status={status}>{status}</span>}
          <button type="button" className="btn small packs" onClick={onOpenPacks}>Packs</button>
        </header>
        <main className="body">{children}</main>
        <div aria-live="polite" className="sr-only">{said}</div>
      </div>
    </Announce.Provider>
  );
}
