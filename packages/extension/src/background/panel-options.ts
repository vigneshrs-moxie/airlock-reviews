import { prRefFromUrl } from '@airlock/shared';

export interface PanelOptions {
  tabId: number;
  path: string;
  enabled: boolean;
}

/** The side panel is on only for a pull request page on github.com. */
export function panelOptionsFor(tabId: number, url: string | undefined): PanelOptions {
  return { tabId, path: 'sidepanel.html', enabled: url !== undefined && prRefFromUrl(url) !== null };
}
