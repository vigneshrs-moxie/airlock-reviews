import type { ReactNode } from 'react';
import type { PanelState } from '../state/reduce';

export type Connection = 'Connected' | 'Not running' | 'Not paired';

export function connectionOf(state: PanelState): Connection {
  if (state.kind === 'offline') return 'Not running';
  if (state.kind === 'unpaired') return 'Not paired';
  return 'Connected';
}

/** The head every screen sits under: the name, the connection in one word, and the Packs button. */
export function Frame({ status, onOpenPacks, children }: { status: Connection; onOpenPacks: () => void; children: ReactNode }) {
  return (
    <div className="panel">
      <header className="head">
        <h1 className="name">Airlock</h1>
        <span className="status" data-status={status}>{status}</span>
        <button type="button" className="btn small" onClick={onOpenPacks}>Packs</button>
      </header>
      <main className="body">{children}</main>
    </div>
  );
}
