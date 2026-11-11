import type { ServiceStatus } from '@airlock/shared';
import { ServiceClient } from '../client/service';
import { realTimers } from '../client/timers';
import { SERVICE_URL } from '../config';
import { PanelScreen } from '../screens/PanelScreen';
import { startPanel, type PanelState } from '../state/machine';
import { browserSettings, type SettingsStore } from '../state/settings';
import { browserTab, type TabWatcher } from '../state/tab';
import { useDefaultDepth, usePanel, type StartPanel } from './usePanel';

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

/** What the Packs screen needs from outside the panel: the service's status and the stored default depth. */
export interface PanelServices { settings: SettingsStore; fetchStatus: () => Promise<ServiceStatus> }

/** The real services: the service at `SERVICE_URL` with the stored token, and the extension's local storage. */
export function realServices(settings: SettingsStore = browserSettings()): PanelServices {
  const client = new ServiceClient(SERVICE_URL, () => settings.getToken());
  return { settings, fetchStatus: () => client.status() };
}

export function App({ start = (onState) => startRealPanel(onState), services }: { start?: StartPanel; services?: PanelServices }) {
  const { state, dispatch } = usePanel(start);
  const { depth, setDepth } = useDefaultDepth(services?.settings);
  return (
    <PanelScreen
      state={state} dispatch={dispatch} defaultDepth={depth} onDefaultDepth={setDepth}
      {...(services ? { fetchStatus: services.fetchStatus } : {})}
    />
  );
}
