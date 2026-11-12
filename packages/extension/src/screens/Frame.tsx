import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode, type Ref, type RefObject } from 'react';
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

/** A small inline icon: drawn with the text's colour, and hidden from screen readers. */
function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      className="icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"
    >
      {children}
    </svg>
  );
}

export const GearIcon = () => (
  <Icon>
    <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
    <circle cx="12" cy="12" r="3" />
  </Icon>
);
export const ChevronLeft = () => <Icon><path d="m15 18-6-6 6-6" /></Icon>;
export const ChevronRight = () => <Icon><path d="m9 18 6-6-6-6" /></Icon>;

/**
 * The top of a screen that replaces the panel's content (Settings, Packs, Service): Back, then the screen's name, which
 * takes focus when the screen opens.
 */
export function ScreenHead({ title, onBack, headingRef }: { title: string; onBack: () => void; headingRef?: RefObject<HTMLHeadingElement | null> }) {
  const own = useRef<HTMLHeadingElement>(null);
  const heading = headingRef ?? own;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { heading.current?.focus(); }, []);
  return (
    <div className="screen-head">
      <button type="button" className="btn small screen-back" onClick={onBack}><ChevronLeft />Back</button>
      <h2 className="title" tabIndex={-1} ref={heading}>{title}</h2>
    </div>
  );
}

/** The head every screen sits under: the mark, the name, the connection in one word, the Settings button and the live region. */
export function Frame({ status, onOpenSettings, settingsRef, timers = realTimers, children }: {
  status: Connection | null; onOpenSettings: () => void; settingsRef?: Ref<HTMLButtonElement>; timers?: Timers; children: ReactNode;
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
          <span className="brand-mark" aria-hidden="true" />
          <h1 className="name">Airlock</h1>
          {status !== null && <span className="status" data-status={status}>{status}</span>}
          <button type="button" className="btn small settings" ref={settingsRef} onClick={onOpenSettings}><GearIcon />Settings</button>
        </header>
        <main className="body" tabIndex={-1}>{children}</main>
        <div aria-live="polite" className="sr-only">{said}</div>
      </div>
    </Announce.Provider>
  );
}
