import { diffAnchorId } from '@airlock/shared';
import { chromium, expect, test, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NotesMessage, PageNote } from '../src/page/protocol';

// The content script's notes on the two fixture views, sent from the extension's worker as the panel will send them.
// The page acts out GitHub's own re-rendering with fixtures/github-live.js.
const BUILT = fileURLToPath(new URL('../.output-e2e/chrome-mv3', import.meta.url));
const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
const LIVE = join(FIXTURES, 'github-live.js');
const CLASSIC_URL = 'https://github.com/acme/widgets/pull/1/files';
const REACT_URL = 'https://github.com/acme/widgets/pull/2/files';
const TITLE = 'Pause skips the guard <b>now</b>';

let context: BrowserContext;
let worker: Worker;
let profile: string;
let pause: string;
let guard: string;

test.beforeAll(async () => {
  profile = await mkdtemp(join(tmpdir(), 'airlock-e2e-'));
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${BUILT}`, `--load-extension=${BUILT}`],
  });
  worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  pause = await diffAnchorId('src/pause.ts');
  guard = await diffAnchorId('src/guard.ts');
  const html = async (name: string) => ({ contentType: 'text/html', body: await readFile(join(FIXTURES, name), 'utf8') });
  const classic = await html('files-classic.html');
  const react = await html('files-react.html');
  await context.route(/^https:\/\/github\.com\/acme\/widgets\/pull\/1\/files/, (route) => route.fulfill(classic));
  await context.route(/^https:\/\/github\.com\/acme\/widgets\/pull\/2\/files/, (route) => route.fulfill(react));
  await context.route('https://github.com/acme/widgets/pull/1', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>conversation</title><p>The conversation page.</p>' }));
  // What the worker receives from content scripts.
  await worker.evaluate(() => {
    const chrome = (globalThis as unknown as { chrome: typeof browser }).chrome;
    const seen: unknown[] = [];
    (globalThis as unknown as { airlockSeen: unknown[] }).airlockSeen = seen;
    chrome.runtime.onMessage.addListener((message, sender) => { seen.push({ message, fromTab: sender.tab !== undefined }); });
  });
});

test.afterAll(async () => {
  await context?.close();
  if (profile) await rm(profile, { recursive: true, force: true });
});

const notesFor = (number: number, notes: PageNote[]): NotesMessage => ({ type: 'airlock:notes', pr: { repo: 'acme/widgets', number }, notes });
const pauseNote = (): PageNote => ({ id: 'c_00000001', anchorId: pause, line: 11, severity: 'fix', title: TITLE });
const guardNote = (): PageNote => ({ id: 'c_00000002', anchorId: guard, line: 4, severity: 'block', title: 'The guard is never read' });
const foldedNote = (): PageNote => ({ id: 'c_00000003', anchorId: pause, line: 99, severity: 'ask', title: 'Outside the diff' });

/** Sends `message` from the worker to the content script of the tab whose address starts with `prefix`; its reply. */
async function sendToTab(prefix: string, message: unknown): Promise<unknown> {
  return worker.evaluate(async ([address, m]) => {
    const chrome = (globalThis as unknown as { chrome: typeof browser }).chrome;
    const tab = (await chrome.tabs.query({})).find((t) => t.url?.startsWith(address));
    if (tab?.id === undefined) throw new Error(`no tab at ${address}`);
    // The script starts when the page is idle: ask again until it listens.
    for (let i = 0; ; i++) {
      try {
        return await chrome.tabs.sendMessage(tab.id, m);
      } catch (e) {
        if (i >= 50) throw e;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  }, [prefix, message] as const);
}

async function open(url: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(url);
  return page;
}

const noteRows = (github: Page) => github.locator('tr[data-airlock-note]');
const noteRow = (github: Page, id: string) => github.locator(`tr[data-airlock-note="${id}"]`);
/** The text of the GitHub row directly above a note's row. */
const above = (github: Page, id: string) =>
  noteRow(github, id).evaluate((row) => row.previousElementSibling?.textContent?.replace(/\s+/g, ' ').trim());
const spanOf = (github: Page, id: string) => noteRow(github, id).evaluate((row) => (row.firstElementChild as HTMLTableCellElement).colSpan);

interface Seen { id: string; text: string; buttonNodeId: number }
type Cdp = Awaited<ReturnType<BrowserContext['newCDPSession']>>;
/**
 * What the person sees inside each note's closed shadow root, read through the DevTools protocol (the page's own scripts
 * cannot open the root; Playwright's locators do not either). The node ids are good for the returned session.
 */
async function insideNotes(github: Page): Promise<{ seen: Seen[]; cdp: Cdp }> {
  type DomNode = {
    nodeId: number; nodeName: string; nodeType: number; nodeValue: string; attributes?: string[];
    children?: DomNode[]; shadowRoots?: DomNode[];
  };
  const cdp = await context.newCDPSession(github);
  const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true }) as { root: DomNode };
  const seen: Seen[] = [];
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

/** Clicks a node at its place on screen, as the person would. */
async function clickNode(github: Page, cdp: Cdp, nodeId: number): Promise<void> {
  await cdp.send('DOM.scrollIntoViewIfNeeded', { nodeId });
  const { model } = await cdp.send('DOM.getBoxModel', { nodeId }) as { model: { content: number[] } };
  const [x1, y1, , , x3, y3] = model.content as [number, number, number, number, number, number];
  await github.mouse.click((x1 + x3) / 2, (y1 + y3) / 2);
}

const seenByWorker = () => worker.evaluate(() => (globalThis as unknown as { airlockSeen: unknown[] }).airlockSeen.splice(0));

for (const [view, url] of [['classic', CLASSIC_URL], ['react', REACT_URL]] as const) {
  test(`notes are placed under their lines in the ${view} fixture, and Open in Airlock sends only the note's id`, async () => {
    const github = await open(url);
    const reply = await sendToTab(url, notesFor(url === CLASSIC_URL ? 1 : 2, [pauseNote(), guardNote(), foldedNote()]));
    expect(reply).toEqual({ placed: 2, waiting: 1, view, missing: [] });
    await expect(noteRows(github)).toHaveCount(2);
    expect(await above(github, 'c_00000001')).toContain('code - 11');
    expect(await above(github, 'c_00000002')).toContain('code - 4');
    expect(await spanOf(github, 'c_00000001')).toBe(3);

    const { seen, cdp } = await insideNotes(github);
    expect(seen.map((s) => [s.id, s.text])).toEqual([
      ['c_00000001', `Fix ${TITLE} Open in Airlock`],
      ['c_00000002', 'Block The guard is never read Open in Airlock'],
    ]);
    // The page's own scripts see a row with an id, a role and a fixed label, and no text of the finding.
    const pageView = await github.evaluate(() => ({
      text: document.body.innerText,
      html: document.documentElement.outerHTML,
      roots: [...document.querySelectorAll('[data-airlock-note] td > *')].map((host) => host.shadowRoot),
      labels: [...document.querySelectorAll('[data-airlock-note], [data-airlock-note] td > *')].map((el) => el.getAttribute('aria-label')),
      bold: document.querySelectorAll('b').length,
    }));
    for (const word of ['Pause skips', 'Open in Airlock', 'guard is never']) {
      expect(pageView.text).not.toContain(word);
      expect(pageView.html).not.toContain(word);
    }
    expect(pageView.roots).toEqual([null, null]);
    expect(pageView.labels).toEqual(['Airlock note', 'Airlock note', 'Airlock note', 'Airlock note']);
    expect(pageView.bold).toBe(0);

    expect(await seenByWorker()).toEqual([]);
    await clickNode(github, cdp, seen[1]!.buttonNodeId);
    await expect.poll(() => worker.evaluate(() => (globalThis as unknown as { airlockSeen: unknown[] }).airlockSeen.length)).toBe(1);
    expect(await seenByWorker()).toEqual([{ message: { type: 'airlock:note-open', id: 'c_00000002' }, fromTab: true }]);

    // Jumping to a line still marks it with the notes on the page.
    const jump = { type: 'airlock:jump', repo: 'acme/widgets', number: url === CLASSIC_URL ? 1 : 2, anchorId: pause, path: 'src/pause.ts', line: 11 };
    expect(await sendToTab(url, jump)).toMatchObject({ ok: true, how: 'line', view });
    await expect(github.locator('.airlock-target')).toHaveCount(view === 'classic' ? 3 : 1);
    await expect(noteRows(github)).toHaveCount(2);
    await github.close();
  });

  test(`in the ${view} fixture a file that loads late, a re-render and the split view keep one note per line`, async () => {
    const github = await open(url);
    await github.addScriptTag({ path: LIVE });
    const live = (op: 'unload' | 'load' | 'rerender' | 'split', anchor = '') => github.evaluate(([o, a]) => {
      (window as unknown as { githubFixture: Record<string, (anchor: string) => void> }).githubFixture[o]!(a);
    }, [op, anchor] as const);
    await live('unload', guard);
    const message = notesFor(url === CLASSIC_URL ? 1 : 2, [pauseNote(), guardNote()]);
    expect(await sendToTab(url, message)).toEqual({ placed: 1, waiting: 1, view, missing: [] });
    await expect(noteRows(github)).toHaveCount(1);

    await live('load', guard);
    await expect(noteRow(github, 'c_00000002')).toHaveCount(1);
    expect(await above(github, 'c_00000002')).toContain('code - 4');

    await live('rerender', pause);
    await expect(noteRow(github, 'c_00000001')).toHaveCount(1);
    expect(await above(github, 'c_00000001')).toContain('code - 11');
    // Put back once, and nothing moves afterwards.
    await github.waitForTimeout(600);
    await expect(noteRows(github)).toHaveCount(2);

    await live('split');
    await expect.poll(() => spanOf(github, 'c_00000001').catch(() => 0)).toBe(4);
    await expect.poll(() => spanOf(github, 'c_00000002').catch(() => 0)).toBe(4);
    await expect(noteRows(github)).toHaveCount(2);
    expect(await above(github, 'c_00000001')).toContain('code - 11');
    expect(await above(github, 'c_00000002')).toContain('code - 4');
    expect(await sendToTab(url, message)).toEqual({ placed: 2, waiting: 0, view, missing: [] });
    await github.close();
  });
}

test('leaving the Files changed view, a message for another pull request, and a clear message each remove every note', async () => {
  const github = await open(CLASSIC_URL);
  const send = (m: unknown) => sendToTab('https://github.com/acme/widgets/pull/1', m);
  expect(await send(notesFor(1, [pauseNote(), guardNote()]))).toMatchObject({ placed: 2 });
  // Another address that is still this Files changed view keeps them.
  await github.evaluate(() => history.pushState(null, '', '/acme/widgets/pull/1/files?w=1'));
  await github.waitForTimeout(1_500);
  await expect(noteRows(github)).toHaveCount(2);
  await github.evaluate(() => history.pushState(null, '', '/acme/widgets/pull/1'));
  await expect(noteRows(github)).toHaveCount(0);

  await github.evaluate(() => history.pushState(null, '', '/acme/widgets/pull/1/files'));
  expect(await send(notesFor(1, [pauseNote(), guardNote()]))).toMatchObject({ placed: 2 });
  expect(await send(notesFor(2, [pauseNote()]))).toEqual({ placed: 0, waiting: 0, view: null, missing: [] });
  await expect(noteRows(github)).toHaveCount(0);

  expect(await send(notesFor(1, [pauseNote()]))).toMatchObject({ placed: 1 });
  expect(await send({ type: 'airlock:notes-clear' })).toEqual({ placed: 0, waiting: 0, view: null, missing: [] });
  await expect(noteRows(github)).toHaveCount(0);
  await github.close();
});

test('a message that fails validation is answered with a sentence and changes nothing', async () => {
  const github = await open(CLASSIC_URL);
  expect(await sendToTab(CLASSIC_URL, notesFor(1, [pauseNote()]))).toMatchObject({ placed: 1 });
  const tooMany = notesFor(1, Array.from({ length: 61 }, (_, i) => ({ ...pauseNote(), id: `c_${String(i).padStart(8, '0')}` })));
  expect(await sendToTab(CLASSIC_URL, tooMany)).toEqual({ error: "The page refused Airlock's notes: more than 60 notes." });
  expect(await sendToTab(CLASSIC_URL, notesFor(1, [{ ...pauseNote(), line: 0 }]))).toEqual({
    error: "The page refused Airlock's notes: a line is not a positive whole number.",
  });
  await expect(noteRows(github)).toHaveCount(1);
  await github.close();
});
