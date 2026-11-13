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

/** A page Playwright does not list, such as a side panel Chrome opened: read through the DevTools protocol, and closed. */
export interface OtherPage { evaluate(expression: string): Promise<unknown>; close(): Promise<void> }

/**
 * The page targets at `url` other than `except`, found through `via` (any page of the browser). Each can run an
 * expression and give back its value, and be closed.
 */
export async function otherPages(context: BrowserContext, via: Page, url: string, except: Page[] = []): Promise<OtherPage[]> {
  const cdp = await context.newCDPSession(via);
  const own = await Promise.all(except.map(async (p) => {
    const session = await context.newCDPSession(p);
    const { targetInfo } = await session.send('Target.getTargetInfo') as { targetInfo: { targetId: string } };
    await session.detach();
    return targetInfo.targetId;
  }));
  const { targetInfos } = await cdp.send('Target.getTargets') as { targetInfos: { targetId: string; type: string; url: string }[] };
  const replies = new Map<number, (result: unknown) => void>();
  cdp.on('Target.receivedMessageFromTarget', ({ message }) => {
    const reply = JSON.parse(message) as { id?: number; result?: { result?: { value?: unknown } } };
    if (reply.id !== undefined) replies.get(reply.id)?.(reply.result?.result?.value);
  });
  let next = 0;
  const pages = await Promise.all(targetInfos.filter((t) => t.type === 'page' && t.url === url && !own.includes(t.targetId)).map(async (t) => {
    // A page that closed between the listing and now (a side panel just closed) is no longer one of them.
    const attached = await cdp.send('Target.attachToTarget', { targetId: t.targetId, flatten: false })
      .then((r) => r as { sessionId: string }, (error: unknown) => {
        if (error instanceof Error && error.message.includes('No target with given id')) return null;
        throw error;
      });
    if (attached === null) return null;
    const { sessionId } = attached;
    return {
      evaluate: (expression: string) => new Promise<unknown>((resolve) => {
        const id = ++next;
        replies.set(id, resolve);
        void cdp.send('Target.sendMessageToTarget', {
          sessionId, message: JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }),
        });
      }),
      close: async () => { await cdp.send('Target.closeTarget', { targetId: t.targetId }); },
    };
  }));
  return pages.filter((p): p is OtherPage => p !== null);
}
