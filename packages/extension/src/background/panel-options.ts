// Imported by path, not from '@airlock/shared': this module has no zod, and Chrome wakes the worker on every tab update.
import { prRefFromUrl } from '../../../shared/src/pr-ref';

export interface PanelOptions {
  tabId: number;
  path: string;
  enabled: boolean;
}

/** The side panel is on only for a pull request page on github.com. */
export function panelOptionsFor(tabId: number, url: string | undefined): PanelOptions {
  return { tabId, path: 'sidepanel.html', enabled: url !== undefined && prRefFromUrl(url) !== null };
}
