import { useCallback, useEffect, useRef, useState } from 'react';
import type { Depth } from '@airlock/shared';
import type { PanelState, UserAction } from '../state/machine';
import type { SettingsStore } from '../state/settings';

/** Starts the panel and reports each state to `onState`; what `startPanel` is, with its pieces already chosen. */
export type StartPanel = (onState: (state: PanelState) => void) => { dispatch(action: UserAction): void; stop(): void };

/** Runs the panel for as long as the component is mounted and returns its latest state and `dispatch`. */
export function usePanel(start: StartPanel): { state: PanelState; dispatch: (action: UserAction) => void } {
  const [state, setState] = useState<PanelState>({ kind: 'loading' });
  const running = useRef<ReturnType<StartPanel> | null>(null);
  const startRef = useRef(start);

  useEffect(() => {
    // A panel that was stopped (StrictMode's first mount, or an unmount) must not change what is shown.
    let live = true;
    const panel = startRef.current((next) => { if (live) setState(next); });
    running.current = panel;
    return () => {
      live = false;
      running.current = null;
      panel.stop();
    };
  }, []);

  const dispatchRef = useRef((action: UserAction): void => running.current?.dispatch(action));
  return { state, dispatch: dispatchRef.current };
}

/** The stored default depth: read once when the panel starts, and updated when it is changed. A change that cannot be stored is undone. */
export function useDefaultDepth(settings: SettingsStore | undefined): { depth: Depth | null; failed: boolean; setDepth: (depth: Depth | null) => void } {
  const [depth, setShown] = useState<Depth | null>(null);
  const [failed, setFailed] = useState(false);
  // What is known to be stored, to go back to.
  const stored = useRef<Depth | null>(null);
  const changed = useRef(false);
  useEffect(() => {
    let live = true;
    settings?.getDefaultDepth().then((value) => {
      if (!live || changed.current) return;
      stored.current = value;
      setShown(value);
    }, () => undefined);
    return () => { live = false; };
  }, [settings]);
  const setDepth = useCallback((next: Depth | null): void => {
    changed.current = true;
    setFailed(false);
    setShown(next);
    settings?.setDefaultDepth(next).then(
      () => { stored.current = next; },
      () => { setShown(stored.current); setFailed(true); },
    );
  }, [settings]);
  return { depth, failed, setDepth };
}
