import { useEffect, useRef, useState } from 'react';
import type { PanelState, UserAction } from '../state/machine';

/** Starts the panel and reports each state to `onState`; what `startPanel` is, with its pieces already chosen. */
export type StartPanel = (onState: (state: PanelState) => void) => { dispatch(action: UserAction): void; stop(): void };

/** Runs the panel for as long as the component is mounted and returns its latest state and `dispatch`. */
export function usePanel(start: StartPanel): { state: PanelState; dispatch: (action: UserAction) => void } {
  const [state, setState] = useState<PanelState>({ kind: 'loading' });
  const running = useRef<ReturnType<StartPanel> | null>(null);
  const startRef = useRef(start);

  useEffect(() => {
    const panel = startRef.current(setState);
    running.current = panel;
    return () => {
      running.current = null;
      panel.stop();
    };
  }, []);

  const dispatchRef = useRef((action: UserAction): void => running.current?.dispatch(action));
  return { state, dispatch: dispatchRef.current };
}
