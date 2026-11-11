import { ServiceClient } from '../client/service';
import { realTimers } from '../client/timers';
import { SERVICE_URL } from '../config';
import { PanelScreen } from '../screens/PanelScreen';
import { startPanel } from '../state/machine';
import { browserSettings } from '../state/settings';
import { browserTab } from '../state/tab';
import { usePanel, type StartPanel } from './usePanel';

/** The real pieces: the service at `SERVICE_URL` with the stored token, the active tab, the clock. */
export const startRealPanel: StartPanel = (onState) => {
  const settings = browserSettings();
  const client = new ServiceClient(SERVICE_URL, () => settings.getToken());
  return startPanel({ client, tab: browserTab(), settings, onState, timers: realTimers });
};

export function App({ start = startRealPanel }: { start?: StartPanel }) {
  const { state, dispatch } = usePanel(start);
  // The Packs screen is a later task; until then the button has nothing to open.
  return <PanelScreen state={state} dispatch={dispatch} onOpenPacks={() => undefined} />;
}
