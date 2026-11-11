import { useEffect, useMemo, useRef, useState } from 'react';
import type { ServiceStatus } from '@airlock/shared';
import { ServiceClient } from '../client/service';
import { realTimers } from '../client/timers';
import { SERVICE_URL } from '../config';
import { PanelScreen } from '../screens/PanelScreen';
import { startPanel, type PanelState } from '../state/machine';
import { browserSettings, type SettingsStore } from '../state/settings';
import { browserJumpChrome, COULD_NOT_JUMP, jumpTo, type Jump, type JumpPlace, type JumpPr, type JumpResult, type PageReport } from '../state/jump';
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

/**
 * What the panel needs from outside it besides the running panel: the service's status and the stored default depth for
 * the Packs screen, and jumping to a place on GitHub (which tells `onReport` what it found on the page).
 */
export interface PanelServices {
  settings: SettingsStore;
  fetchStatus: () => Promise<ServiceStatus>;
  jump?: (pr: JumpPr, place: JumpPlace, options: JumpServiceOptions) => Promise<JumpResult>;
}

/** `reload`: the person asked to reload the GitHub tab first. `signal`: aborted when a newer jump starts. */
export interface JumpServiceOptions { reload: boolean; signal: AbortSignal; onReport: (report: PageReport) => void }

/** Jumps in the tab the panel sits beside. Needs no service, so it works while the service is away. Never rejects. */
async function jumpBeside(tab: TabWatcher, pr: JumpPr, place: JumpPlace, { reload, signal, onReport }: JumpServiceOptions): Promise<JumpResult> {
  try {
    const { tabId } = await tab.current();
    return await jumpTo(browserJumpChrome(onReport), tabId, pr, place, { reload, signal });
  } catch {
    return { sentence: COULD_NOT_JUMP, needsReload: false };
  }
}

/**
 * The real services: the service at `SERVICE_URL` with the stored token, the extension's local storage, and the tab the
 * panel sits beside (pass the panel's own watcher so both read the same tab).
 */
export function realServices(settings: SettingsStore = browserSettings(), tab: TabWatcher = browserTab()): PanelServices {
  const client = new ServiceClient(SERVICE_URL, () => settings.getToken());
  return {
    settings,
    fetchStatus: () => client.status(),
    jump: (pr, place, options) => jumpBeside(tab, pr, place, options),
  };
}

export function App({ start = (onState) => startRealPanel(onState), services }: { start?: StartPanel; services?: PanelServices }) {
  const { state, dispatch } = usePanel(start);
  const { depth, failed, setDepth } = useDefaultDepth(services?.settings);
  const [pageReport, setPageReport] = useState<PageReport | null>(null);
  const jump = services?.jump;
  // Only the latest jump runs and reports: starting one aborts the one before, and a late report is dropped.
  const latestJump = useRef(0);
  const running = useRef<AbortController | null>(null);
  useEffect(() => () => running.current?.abort(), []);
  const onJump = useMemo((): Jump | undefined => {
    if (!jump) return undefined;
    return (pr, place, { reload }) => {
      const mine = ++latestJump.current;
      running.current?.abort();
      const controller = new AbortController();
      running.current = controller;
      const onReport = (report: PageReport): void => { if (mine === latestJump.current) setPageReport(report); };
      return jump(pr, place, { reload, signal: controller.signal, onReport });
    };
  }, [jump]);
  return (
    <PanelScreen
      state={state} dispatch={dispatch} defaultDepth={depth} onDefaultDepth={setDepth} depthFailed={failed}
      pageReport={pageReport} {...(onJump ? { onJump } : {})}
      {...(services ? { fetchStatus: services.fetchStatus } : {})}
    />
  );
}
