import type { BrowserContext, Page } from '@playwright/test';

// Reading Airlock's notes on a page as the person sees them, and pressing their buttons as the person would. The notes'
// insides are in closed shadow roots: the page's own scripts cannot open them, and Playwright's locators do not either.

export interface SeenNote { id: string; text: string; buttonNodeId: number }
export type Cdp = Awaited<ReturnType<BrowserContext['newCDPSession']>>;

/** What each note shows, read through the DevTools protocol. The node ids are good for the returned session. */
export async function insideNotes(context: BrowserContext, page: Page): Promise<{ seen: SeenNote[]; cdp: Cdp }> {
  type DomNode = {
    nodeId: number; nodeName: string; nodeType: number; nodeValue: string; attributes?: string[];
    children?: DomNode[]; shadowRoots?: DomNode[];
  };
  const cdp = await context.newCDPSession(page);
  const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true }) as { root: DomNode };
  const seen: SeenNote[] = [];
  const kids = (n: DomNode): DomNode[] => [...(n.shadowRoots ?? []), ...(n.children ?? [])];
  const text = (n: DomNode): string => n.nodeName === 'STYLE' ? '' : n.nodeType === 3 ? n.nodeValue : kids(n).map(text).join(' ');
  const find = (n: DomNode, name: string): DomNode | undefined =>
    n.nodeName === name ? n : kids(n).map((k) => find(k, name)).find((k) => k !== undefined);
  const walk = (n: DomNode): void => {
    const attrs = n.attributes ?? [];
    const at = attrs.indexOf('data-airlock-note');
    if (n.nodeName === 'TR' && at >= 0) {
      seen.push({ id: attrs[at + 1]!, text: text(n).replace(/\s+/g, ' ').trim(), buttonNodeId: find(n, 'BUTTON')!.nodeId });
      return;
    }
    kids(n).forEach(walk);
  };
  walk(root);
  return { seen, cdp };
}

/** Clicks a node at its place on screen with the mouse, as the person would. */
export async function clickNode(page: Page, cdp: Cdp, nodeId: number): Promise<void> {
  await cdp.send('DOM.scrollIntoViewIfNeeded', { nodeId });
  const { model } = await cdp.send('DOM.getBoxModel', { nodeId }) as { model: { content: number[] } };
  const [x1, y1, , , x3, y3] = model.content as [number, number, number, number, number, number];
  await page.mouse.click((x1 + x3) / 2, (y1 + y3) / 2);
}
