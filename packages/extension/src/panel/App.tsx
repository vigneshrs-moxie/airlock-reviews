import { ServiceClient } from '../client/service';
import { realTimers } from '../client/timers';
import { SERVICE_URL } from '../config';
import { PanelScreen } from '../screens/PanelScreen';
import { startPanel, type PanelState } from '../state/machine';
import { browserSettings, type SettingsStore } from '../state/settings';
import { browserTab, type TabWatcher } from '../state/tab';
import { usePanel, type StartPanel } from './usePanel';

/** The Chrome pieces the panel runs on; fakes in tests. */
export interface ChromePieces { settings: SettingsStore; tab: TabWatcher }

/** The real construction: the service at `SERVICE_URL` with the stored token, the tab watcher, the real clock. */
export function startRealPanel(
  onState: (state: PanelState) => void,
  pieces: ChromePieces = { settings: browserSettings(), tab: browserTab() },
  run: typeof startPanel = startPanel,
): ReturnType<StartPanel> {
  const { settings, tab } = pieces;
  const client = new ServiceClient(SERVICE_URL, () => settings.getToken());
  return run({ client, tab, settings, onState, timers: realTimers });
}

export function App({ start = (onState) => startRealPanel(onState) }: { start?: StartPanel }) {
  const { state, dispatch } = usePanel(start);
  // The Packs screen is a later task; until then the button has nothing to open.
  return <PanelScreen state={state} dispatch={dispatch} onOpenPacks={() => undefined} />;
}
