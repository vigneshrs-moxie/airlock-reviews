// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOOK_MS, STEP_MS, createPage, listen, locationChanged, type Page, type PageEnv, type RuntimeLike } from '../../src/page/jump';
import { parseJumpRequest, type JumpRequest } from '../../src/page/protocol';
import { CLASSIC, REACT } from '../../src/page/selectors';
import { onSoftNavigation } from '../../src/page/soft-nav';
import { CLASSIC_HTML, GUARD, PAUSE, REACT_HTML, load } from './page-fixtures';

afterEach(() => { document.documentElement.innerHTML = '<head></head><body></body>'; });

const FILES = 'https://github.com/acme/widgets/pull/1/files';
const MARK = 'airlock-target';

/** A page at `href`, with a clock that moves only when the page waits. `onWait` runs after each wait. */
function env(href = FILES, onWait: (elapsed: number) => void = () => undefined) {
  const log: string[] = [];
  let url = new URL(href);
  let elapsed = 0;
  const waits: number[] = [];
  const location = {
    get href() { return url.href; },
    get hash() { return url.hash; },
    set hash(value: string) { log.push(`hash ${value}`); url = new URL(url.href); url.hash = value; },
  };
  const e: PageEnv = {
    doc: document, location,
    now: () => elapsed,
    wait: async (ms) => { waits.push(ms); elapsed += ms; onWait(elapsed); },
  };
  return { env: e, log, waits, go: (next: string) => { url = new URL(next); } };
}

const request = (over: Partial<JumpRequest> = {}): JumpRequest => ({
  type: 'airlock:jump', repo: 'acme/widgets', number: 1, anchorId: PAUSE, path: 'src/pause.ts', line: 11, ...over,
});
/** A message as it might arrive, valid or not. */
const raw = (over: Record<string, unknown>): Record<string, unknown> => ({ ...request(), ...over });
const marked = (): Element[] => [...document.querySelectorAll(`.${MARK}`)];
const styles = (): Element[] => [...document.querySelectorAll('style')];
const newSideCell = (anchorId: string, line: number) => document.getElementById(`${anchorId}R${line}`)!;

describe('answering a jump on the Files changed page', () => {
  it('in the classic view sets the address fragment, marks the row cells, and answers line', async () => {
    load(CLASSIC_HTML);
    const page = env();
    const scrolled = vi.spyOn(HTMLElement.prototype, 'scrollIntoView');
    const reply = await createPage(page.env).answer(request());
    expect(reply).toEqual({ ok: true, how: 'line', view: 'classic', missing: [] });
    expect(page.env.location.hash).toBe(`#${PAUSE}R11`);
    const row = newSideCell(PAUSE, 11).closest('tr')!;
    expect(marked()).toEqual([...row.querySelectorAll('td')]);
    expect(page.waits).toEqual([]);
    expect(scrolled.mock.contexts).toEqual([row]);
    scrolled.mockRestore();
  });

  it('lets a newer request take over from one still looking', async () => {
    load(CLASSIC_HTML);
    const page = env();
    const p = createPage(page.env);
    const older = p.answer(request({ line: 99 }));
    const newer = await p.answer(request({ anchorId: GUARD, path: 'src/guard.ts', line: 4 }));
    expect(newer).toMatchObject({ ok: true, how: 'line' });
    expect(await older).toMatchObject({ ok: true, how: 'asked' });
    expect(page.waits.length).toBeLessThan(LOOK_MS / STEP_MS);
    expect(marked()).toEqual([...newSideCell(GUARD, 4).closest('tr')!.querySelectorAll('td')]);
  });

  it('in the newer view marks the row and answers line', async () => {
    load(REACT_HTML);
    const page = env();
    const reply = await createPage(page.env).answer(request());
    expect(reply).toEqual({ ok: true, how: 'line', view: 'react', missing: [] });
    expect(page.env.location.hash).toBe(`#${PAUSE}R11`);
    expect(marked()).toHaveLength(1);
    expect(marked()[0]!.tagName).toBe('TR');
    expect(marked()[0]!.textContent).toContain('code - 11');
  });

  it('sets the address fragment to the anchor and line before looking for the row', async () => {
    load(CLASSIC_HTML);
    const page = env();
    const byId = vi.spyOn(document, 'getElementById').mockImplementation(function (this: Document, id: string) {
      page.log.push(`look ${id}`);
      return Document.prototype.getElementById.call(this, id);
    });
    const bySelector = vi.spyOn(document, 'querySelector').mockImplementation(function (this: Document, css: string) {
      page.log.push(`look ${css}`);
      return Document.prototype.querySelector.call(this, css);
    });
    await createPage(page.env).answer(request());
    byId.mockRestore();
    bySelector.mockRestore();
    expect(page.log[0]).toBe(`hash #${PAUSE}R11`);
    expect(page.log.slice(1).every((entry) => entry.startsWith('look '))).toBe(true);
    expect(page.log.length).toBeGreaterThan(1);
  });

  it('sets only the anchor when there is no line, and answers file once the file is there', async () => {
    load(REACT_HTML);
    const page = env();
    const reply = await createPage(page.env).answer(request({ line: null }));
    expect(reply).toEqual({ ok: true, how: 'file', view: 'react', missing: [] });
    expect(page.env.location.hash).toBe(`#${PAUSE}`);
    expect(page.waits).toEqual([]);
  });

  it('looks for a row for three seconds, then answers asked and leaves nothing marked (line-not-on-page)', async () => {
    load(CLASSIC_HTML);
    const page = env();
    const p = createPage(page.env);
    await p.answer(request());
    expect(marked().length).toBeGreaterThan(0);
    const reply = await p.answer(request({ line: 99 }));
    expect(reply).toEqual({ ok: true, how: 'asked', view: 'classic', missing: [] });
    expect(page.env.location.hash).toBe(`#${PAUSE}R99`);
    expect(page.waits.every((ms) => ms === STEP_MS)).toBe(true);
    expect(page.waits.reduce((a, b) => a + b, 0)).toBe(LOOK_MS);
    expect(marked()).toEqual([]);
  });

  it('finds a row GitHub renders while it looks', async () => {
    load('<head></head><body></body>');
    const page = env(FILES, (elapsed) => { if (elapsed === 300) load(REACT_HTML); });
    const reply = await createPage(page.env).answer(request());
    expect(reply).toMatchObject({ ok: true, how: 'line', view: 'react' });
    expect(page.waits).toEqual([STEP_MS, STEP_MS, STEP_MS]);
  });

  it('answers file-not-on-page when the file has not loaded by the deadline', async () => {
    load(CLASSIC_HTML);
    document.getElementById(GUARD)!.closest('copilot-diff-entry')!.remove();
    const page = env();
    const reply = await createPage(page.env).answer(request({ anchorId: GUARD, path: 'src/guard.ts', line: 4 }));
    expect(reply).toEqual({ ok: false, reason: 'file-not-on-page', view: 'classic', missing: [] });
    expect(page.env.location.hash).toBe(`#${GUARD}R4`);
  });

  it('on a page with neither view it still sets the address fragment, answers asked, and names the selectors that failed', async () => {
    load('<head></head><body><div id="files"></div></body>');
    const page = env();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const reply = await createPage(page.env).answer(request());
    expect(page.env.location.hash).toBe(`#${PAUSE}R11`);
    expect(reply).toEqual({ ok: true, how: 'asked', view: null, missing: [CLASSIC.file.name, REACT.file.name, REACT.toolbar.name] });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(CLASSIC.file.name));
    warn.mockRestore();
  });

  it('scrolls to the file container on every file-only jump, also when the fragment is unchanged', async () => {
    load(CLASSIC_HTML);
    const page = env();
    const p = createPage(page.env);
    const scrolled = vi.spyOn(HTMLElement.prototype, 'scrollIntoView');
    for (let i = 0; i < 2; i++) {
      expect(await p.answer(request({ line: null }))).toMatchObject({ ok: true, how: 'file' });
    }
    expect(page.env.location.hash).toBe(`#${PAUSE}`);
    const file = document.getElementById(PAUSE);
    expect(scrolled.mock.contexts).toEqual([file, file]);
    expect(scrolled.mock.calls).toEqual([[{ block: 'start' }], [{ block: 'start' }]]);
    scrolled.mockRestore();
  });

  it('answers not-files-page on another pull request\'s Files changed page, and matches the repository ignoring case', async () => {
    load(CLASSIC_HTML);
    for (const href of ['https://github.com/acme/widgets/pull/2/files', 'https://github.com/acme/gadgets/pull/1/files']) {
      const page = env(href);
      expect(await createPage(page.env).answer(request())).toEqual({ ok: false, reason: 'not-files-page', view: null, missing: [] });
      expect(page.log).toEqual([]);
    }
    const page = env('https://github.com/ACME/Widgets/pull/1/files');
    expect(await createPage(page.env).answer(request())).toMatchObject({ ok: true, how: 'line' });
    expect(await createPage(env('https://github.com/acme/widgets/pull/1/changes').env).answer(request({ repo: 'Acme/WIDGETS' }))).toMatchObject({ ok: true, how: 'line' });
  });

  it('answers not-files-page on any other page and leaves its address alone', async () => {
    load(CLASSIC_HTML);
    // One commit's diff in the newer view is not the pull request's Files changed view.
    for (const href of ['https://github.com/acme/widgets/pull/1', 'https://github.com/acme/widgets/pull/1/commits', 'https://github.com/acme/widgets', `https://github.com/acme/widgets/pull/1/changes/${'a'.repeat(40)}`]) {
      const page = env(href);
      const reply = await createPage(page.env).answer(request());
      expect(reply).toEqual({ ok: false, reason: 'not-files-page', view: null, missing: [] });
      expect(page.log).toEqual([]);
    }
    expect(marked()).toEqual([]);
  });

  it('marks the target and unmarks the previous one, with one stylesheet', async () => {
    load(CLASSIC_HTML);
    const p = createPage(env().env);
    await p.answer(request());
    const first = newSideCell(PAUSE, 11).closest('tr')!;
    expect(first.querySelector(`.${MARK}`)).not.toBeNull();
    await p.answer(request({ anchorId: GUARD, path: 'src/guard.ts', line: 4 }));
    expect(first.querySelector(`.${MARK}`)).toBeNull();
    expect(marked()).toEqual([...newSideCell(GUARD, 4).closest('tr')!.querySelectorAll('td')]);
    expect(styles()).toHaveLength(1);
    expect(styles()[0]!.textContent).toContain(`.${MARK}`);
    expect(styles()[0]!.textContent).toContain('outline');
  });

  it('clears the mark on a soft navigation, and not when the address is the one it set', async () => {
    load(REACT_HTML);
    const page = env();
    const p = createPage(page.env);
    await p.answer(request());
    p.softNavigated('popstate');
    expect(marked()).toHaveLength(1);
    for (const event of ['turbo:render', 'soft-nav:end'] as const) {
      await p.answer(request());
      p.softNavigated(event);
      expect(marked(), event).toEqual([]);
    }
    await p.answer(request());
    page.go('https://github.com/acme/widgets/pull/1');
    p.softNavigated('popstate');
    expect(marked()).toEqual([]);
  });

  it('clears the mark on any address change, except to the address it was made at', async () => {
    load(REACT_HTML);
    const page = env();
    const p = createPage(page.env);
    await p.answer(request());
    p.softNavigated('locationchange', page.env.location.href);
    expect(marked()).toHaveLength(1);
    // The watcher can report a change before the address is committed: the destination decides, not location.href.
    p.softNavigated('locationchange', `${FILES}?w=1`);
    expect(marked()).toEqual([]);
  });

  it('creates no element but its one stylesheet and never sets markup', async () => {
    load(REACT_HTML);
    const before = document.querySelectorAll('*').length;
    const create = vi.spyOn(document, 'createElement');
    const p = createPage(env().env);
    await p.answer(request());
    await p.answer(request({ anchorId: GUARD, path: 'src/guard.ts', line: 4 }));
    expect(create.mock.calls.map(([tag]) => tag)).toEqual(['style']);
    expect(document.querySelectorAll('*').length).toBe(before + 1);
    create.mockRestore();
  });
});

describe('the message listener', () => {
  const ID = 'nbcmjckbkploiemllhkmhegjimgeimoa';
  function runtime() {
    const listeners: Parameters<RuntimeLike['onMessage']['addListener']>[0][] = [];
    const rt: RuntimeLike = { id: ID, onMessage: { addListener: (fn) => void listeners.push(fn) } };
    const send = async (message: unknown, sender: { id?: string } = { id: ID }) => {
      const replies: unknown[] = [];
      const kept = listeners[0]!(message, sender, (r) => void replies.push(r));
      await new Promise((r) => setTimeout(r, 0));
      return { kept, replies };
    };
    return { rt, listeners, send };
  }

  it('answers a valid request from this extension and keeps the channel open for the answer', async () => {
    load(CLASSIC_HTML);
    const r = runtime();
    listen(r.rt, createPage(env().env));
    const { kept, replies } = await r.send(request());
    expect(kept).toBe(true);
    expect(replies).toEqual([{ ok: true, how: 'line', view: 'classic', missing: [] }]);
  });

  it('always replies: a failure inside the answer replies not-files-page', async () => {
    const r = runtime();
    const failing: Page = { answer: () => Promise.reject(new Error('boom')), softNavigated: () => undefined };
    listen(r.rt, failing);
    const { kept, replies } = await r.send(request());
    expect(kept).toBe(true);
    expect(replies).toEqual([{ ok: false, reason: 'not-files-page', view: null, missing: [] }]);
  });

  it('registers its listener once', () => {
    const r = runtime();
    const page = createPage(env().env);
    listen(r.rt, page);
    listen(r.rt, page);
    expect(r.listeners).toHaveLength(1);
  });

  it('ignores a message of another type and a message from another sender', async () => {
    load(CLASSIC_HTML);
    const r = runtime();
    const page = env();
    listen(r.rt, createPage(page.env));
    for (const [message, sender] of [
      [raw({ type: 'airlock:other' }), { id: ID }],
      [request(), { id: 'abcdefghijklmnopabcdefghijklmnop' }],
      [request(), {}],
      ['airlock:jump', { id: ID }],
      [null, { id: ID }],
    ] as const) {
      const { kept, replies } = await r.send(message, sender);
      expect(kept, JSON.stringify(message)).not.toBe(true);
      expect(replies).toEqual([]);
    }
    expect(page.log).toEqual([]);
    expect(marked()).toEqual([]);
  });

  it('ignores a bad anchor, an over-long path, a line that is not a positive safe integer, and extra fields', async () => {
    load(CLASSIC_HTML);
    const r = runtime();
    const page = env();
    listen(r.rt, createPage(page.env));
    const bad = [
      raw({ anchorId: 'diff-xyz' }),
      raw({ anchorId: `${PAUSE}R11` }),
      raw({ anchorId: PAUSE.toUpperCase() }),
      raw({ path: 'a'.repeat(1001) }),
      raw({ path: 7 }),
      raw({ line: 1.5 }),
      raw({ line: 0 }),
      raw({ line: -3 }),
      raw({ line: 2 ** 53 }),
      raw({ line: '11' }),
      raw({ line: undefined }),
      raw({ extra: true }),
      raw({ repo: 'acme' }),
      raw({ repo: 'acme/widgets/x' }),
      raw({ repo: 7 }),
      raw({ number: 0 }),
      raw({ number: 1.5 }),
      raw({ number: '1' }),
      raw({ number: 2 ** 53 }),
      (({ repo: _repo, ...rest }) => rest)(request()),
      [request()],
    ];
    for (const message of bad) {
      const { kept, replies } = await r.send(message);
      expect(kept, JSON.stringify(message)).not.toBe(true);
      expect(replies).toEqual([]);
    }
    expect(page.log).toEqual([]);
    const { replies } = await r.send(request({ path: 'a'.repeat(1000) }));
    expect(replies).toHaveLength(1);
  });
});

describe('onSoftNavigation', () => {
  it('reports turbo:render and soft-nav:end on the document and popstate on the window, until stopped', () => {
    const seen: string[] = [];
    const stop = onSoftNavigation(document, window, (event) => seen.push(event));
    document.dispatchEvent(new Event('turbo:render'));
    document.dispatchEvent(new Event('soft-nav:end'));
    window.dispatchEvent(new Event('popstate'));
    document.dispatchEvent(new Event('click'));
    expect(seen).toEqual(['turbo:render', 'soft-nav:end', 'popstate']);
    stop();
    document.dispatchEvent(new Event('turbo:render'));
    expect(seen).toHaveLength(3);
  });
});

describe('locationChanged', () => {
  it('passes the destination of an address change on, and ignores an event without one instead of throwing', () => {
    const page: Page = { answer: () => Promise.reject(new Error('unused')), softNavigated: vi.fn() };
    expect(() => locationChanged(page, new Event('wxt:locationchange'))).not.toThrow();
    expect(() => locationChanged(page, Object.assign(new Event('x'), { newUrl: null }))).not.toThrow();
    expect(page.softNavigated).not.toHaveBeenCalled();
    locationChanged(page, Object.assign(new Event('x'), { newUrl: new URL(`${FILES}?w=1`) }));
    expect(page.softNavigated).toHaveBeenCalledWith('locationchange', `${FILES}?w=1`);
  });
});

describe('parseJumpRequest', () => {
  it('accepts exactly the six fields with valid values, and nothing else', () => {
    expect(parseJumpRequest(request())).toEqual(request());
    expect(parseJumpRequest(request({ line: null }))).toEqual(request({ line: null }));
    expect(parseJumpRequest({ ...request(), line: 11.0 })).toEqual(request());
    expect(parseJumpRequest({ ...request(), constructor: 1 })).toBeNull();
    expect(parseJumpRequest(undefined)).toBeNull();
    expect(parseJumpRequest('{"type":"airlock:jump"}')).toBeNull();
  });
});
