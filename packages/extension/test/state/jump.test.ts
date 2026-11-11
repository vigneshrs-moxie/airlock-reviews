import { describe, expect, it } from 'vitest';
import type { JumpReply, JumpRequest } from '../../src/page/messages';
import {
  LOAD_MS, connectedPlace, jumpTo, ownPlace, pageWords, tabLoaded,
  type JumpChrome, type JumpPlace, type PageReport, type TabsEvents,
} from '../../src/state/jump';
import { FakeTimers } from '../helpers/fake-timers';
import { finding } from '../screens/review-fixtures';

const PAUSE = 'diff-e116c16eefc8e8d9ec8ba37d3740b95e349244231679912217713dcfed49b434';
const HEAD = 'b'.repeat(40);
const PR = { repo: 'acme/widgets', number: 1, headSha: HEAD };
const TAB = 7;
const FILES = 'https://github.com/acme/widgets/pull/1/files';

type Answer = JumpReply | 'no-receiver' | unknown;
const NO_RECEIVER = 'no-receiver';

/** A tab that answers each message with the next scripted answer, and records what was done to it, in order. */
function fakeChrome(answers: Answer[], opts: { update?: () => Promise<unknown>; create?: () => Promise<unknown> } = {}) {
  const log: string[] = [];
  const sent: JumpRequest[] = [];
  const reports: PageReport[] = [];
  const chrome: JumpChrome = {
    async sendMessage(tabId, message) {
      expect(tabId).toBe(TAB);
      sent.push(message);
      log.push('send');
      const answer = answers.shift();
      if (answer === NO_RECEIVER || answer === undefined) throw new Error('Could not establish connection. Receiving end does not exist.');
      return answer;
    },
    async updateTab(tabId, props) {
      expect(tabId).toBe(TAB);
      log.push(`update ${props.url}`);
      return opts.update?.();
    },
    async createTab(props) {
      log.push(`create ${props.url}`);
      return opts.create?.();
    },
    async loaded(tabId) {
      expect(tabId).toBe(TAB);
      log.push('watch load');
    },
    onReport: (report) => void reports.push(report),
  };
  return { chrome, log, sent, reports };
}

const line: JumpReply = { ok: true, how: 'line', view: 'classic', missing: [] };
const place = (over: Partial<JumpPlace> = {}): JumpPlace => ({ path: 'src/pause.ts', line: 11, kind: 'changed', ...over });

describe('jumpTo on the Files changed page', () => {
  it('sends the anchor and line and says it is showing the line', async () => {
    const f = fakeChrome([line]);
    expect(await jumpTo(f.chrome, TAB, PR, place())).toBe('Showing src/pause.ts:11.');
    expect(f.sent).toEqual([{ type: 'airlock:jump', anchorId: PAUSE, path: 'src/pause.ts', line: 11 }]);
    expect(f.log).toEqual(['send']);
    expect(f.reports).toEqual([{ view: 'classic', missing: [] }]);
  });

  it('says it asked GitHub when the row was not found', async () => {
    const f = fakeChrome([{ ok: true, how: 'asked', view: 'react', missing: [] }]);
    expect(await jumpTo(f.chrome, TAB, PR, place())).toBe('Asked GitHub to show src/pause.ts:11.');
  });

  it('asks for the file alone when there is no line', async () => {
    const f = fakeChrome([{ ok: true, how: 'file', view: 'react', missing: [] }]);
    expect(await jumpTo(f.chrome, TAB, PR, place({ line: null }))).toBe('Asked GitHub to show src/pause.ts.');
    expect(f.sent[0]?.line).toBeNull();
  });

  it('shows the file for a line outside the changed lines, without asking for the line', async () => {
    const f = fakeChrome([{ ok: true, how: 'file', view: 'classic', missing: [] }]);
    expect(await jumpTo(f.chrome, TAB, PR, place({ kind: 'outside', line: 40 }))).toBe('Showing src/pause.ts; that line is outside the changed lines.');
    expect(f.sent[0]?.line).toBeNull();
  });

  it('jumpTo reports a file GitHub has not loaded', async () => {
    const f = fakeChrome([{ ok: false, reason: 'file-not-on-page', view: 'react', missing: [] }]);
    expect(await jumpTo(f.chrome, TAB, PR, place())).toBe('GitHub has not loaded src/pause.ts on this page yet. Scroll to it, then try again.');
    expect(f.log).toEqual(['send']);
  });

  it('says when it does not recognise the page, and reports the selectors that found nothing', async () => {
    const f = fakeChrome([{ ok: true, how: 'asked', view: null, missing: ['classic-file', 'react-file'] }]);
    expect(await jumpTo(f.chrome, TAB, PR, place())).toBe('Asked GitHub to show src/pause.ts:11. Airlock does not recognise this version of the page.');
    expect(f.reports).toEqual([{ view: null, missing: ['classic-file', 'react-file'] }]);
    const g = fakeChrome([{ ok: true, how: 'asked', view: null, missing: [] }]);
    expect(await jumpTo(g.chrome, TAB, PR, place({ line: null }))).toBe('Asked GitHub to show src/pause.ts. Airlock does not recognise this version of the page.');
  });

  it('shows a path as written', async () => {
    const path = 'src/<b>x</b> & "y".ts';
    const f = fakeChrome([line]);
    expect(await jumpTo(f.chrome, TAB, PR, place({ path }))).toBe(`Showing ${path}:11.`);
  });

  it('never asks for a line that is not a positive whole number', async () => {
    const f = fakeChrome([{ ok: true, how: 'file', view: 'classic', missing: [] }]);
    expect(await jumpTo(f.chrome, TAB, PR, place({ line: 0 }))).toBe('Asked GitHub to show src/pause.ts.');
    expect(f.sent[0]?.line).toBeNull();
  });
});

describe('jumpTo away from the Files changed page', () => {
  it('jumpTo navigates to the Files changed page when the tab is on the conversation', async () => {
    const f = fakeChrome([{ ok: false, reason: 'not-files-page', view: null, missing: [] }, line]);
    expect(await jumpTo(f.chrome, TAB, PR, place())).toBe('Showing src/pause.ts:11.');
    expect(f.log).toEqual(['send', 'watch load', `update ${FILES}#${PAUSE}R11`, 'send']);
    expect(f.reports).toEqual([{ view: 'classic', missing: [] }]);
  });

  it('navigates without the line for a line outside the changed lines', async () => {
    const f = fakeChrome([NO_RECEIVER, { ok: true, how: 'file', view: 'classic', missing: [] }]);
    expect(await jumpTo(f.chrome, TAB, PR, place({ kind: 'outside' }))).toBe('Showing src/pause.ts; that line is outside the changed lines.');
    expect(f.log).toEqual(['send', 'watch load', `update ${FILES}#${PAUSE}`, 'send']);
  });

  it('treats a tab with no content script like one that is not on the Files changed page', async () => {
    const f = fakeChrome([NO_RECEIVER, line]);
    expect(await jumpTo(f.chrome, TAB, PR, place())).toBe('Showing src/pause.ts:11.');
    expect(f.log).toEqual(['send', 'watch load', `update ${FILES}#${PAUSE}R11`, 'send']);
  });

  it('treats a reply it does not understand as no answer', async () => {
    const f = fakeChrome([{ ok: true, how: 'everything' }, { ok: 'yes' }]);
    expect(await jumpTo(f.chrome, TAB, PR, place())).toBe('Airlock opened the Files changed page but could not reach it. Try the button again.');
    expect(f.reports).toEqual([]);
  });

  it('says it could not reach the page when the navigation never completes and nothing answers', async () => {
    const f = fakeChrome([NO_RECEIVER, NO_RECEIVER]);
    expect(await jumpTo(f.chrome, TAB, PR, place())).toBe('Airlock opened the Files changed page but could not reach it. Try the button again.');
    expect(f.log).toEqual(['send', 'watch load', `update ${FILES}#${PAUSE}R11`, 'send']);
  });

  it('says the same when the page after navigating is still not the Files changed page', async () => {
    const notFiles: JumpReply = { ok: false, reason: 'not-files-page', view: null, missing: [] };
    const f = fakeChrome([notFiles, notFiles]);
    expect(await jumpTo(f.chrome, TAB, PR, place())).toBe('Airlock opened the Files changed page but could not reach it. Try the button again.');
  });

  it('never throws: a failed navigation resolves to a sentence', async () => {
    const f = fakeChrome([NO_RECEIVER], { update: () => Promise.reject(new Error('No tab with id: 7.')) });
    expect(await jumpTo(f.chrome, TAB, PR, place())).toBe('Airlock could not jump to that place.');
  });
});

describe('jumpTo for a file outside the pull request', () => {
  it('jumpTo opens a file outside the pull request in a new tab', async () => {
    const f = fakeChrome([]);
    expect(await jumpTo(f.chrome, TAB, PR, place({ path: 'src/guard.ts', line: 4, kind: 'elsewhere' })))
      .toBe('Opened src/guard.ts in a new tab; it is not part of this pull request.');
    expect(f.log).toEqual([`create https://github.com/acme/widgets/blob/${HEAD}/src/guard.ts#L4`]);
    expect(f.reports).toEqual([]);
  });

  it('opens it at the top when there is no line', async () => {
    const f = fakeChrome([]);
    await jumpTo(f.chrome, TAB, PR, place({ path: 'src/guard.ts', line: null, kind: 'elsewhere' }));
    expect(f.log).toEqual([`create https://github.com/acme/widgets/blob/${HEAD}/src/guard.ts`]);
  });

  it('never throws when the new tab cannot be opened', async () => {
    const f = fakeChrome([], { create: () => Promise.reject(new Error('no')) });
    expect(await jumpTo(f.chrome, TAB, PR, place({ kind: 'elsewhere' }))).toBe('Airlock could not jump to that place.');
  });
});

describe('jumpTo opens nothing and says so when the path cannot be put in an address', () => {
  it('jumpTo opens nothing and says so when the path cannot be put in an address', async () => {
    for (const path of ['../secret', '/etc/passwd', 'a//b', 'a\\b']) {
      const f = fakeChrome([]);
      expect(await jumpTo(f.chrome, TAB, PR, place({ path, kind: 'elsewhere' }))).toBe(`Airlock cannot build a link to ${path}.`);
      expect(f.log).toEqual([]);
    }
  });

  it('when filesUrl returns null, nothing is sent or opened', async () => {
    for (const pr of [{ ...PR, repo: 'not a repo' }, { ...PR, number: 0 }]) {
      const f = fakeChrome([line]);
      expect(await jumpTo(f.chrome, TAB, pr, place())).toBe('Airlock cannot build a link to src/pause.ts.');
      expect(f.log).toEqual([]);
    }
  });

  it('when blobUrl returns null for a bad commit, nothing is opened', async () => {
    const f = fakeChrome([]);
    expect(await jumpTo(f.chrome, TAB, { ...PR, headSha: 'nope' }, place({ kind: 'elsewhere' }))).toBe('Airlock cannot build a link to src/pause.ts.');
    expect(f.log).toEqual([]);
  });
});

describe('tabLoaded', () => {
  type Listener = Parameters<TabsEvents['onUpdated']['addListener']>[0];
  function events() {
    const listeners = new Set<Listener>();
    const tabs: TabsEvents = {
      onUpdated: { addListener: (fn) => void listeners.add(fn), removeListener: (fn) => void listeners.delete(fn) },
    };
    return { tabs, listeners, update: (id: number, status: string) => { for (const fn of [...listeners]) fn(id, { status }); } };
  }

  it('resolves when that tab finishes loading, and stops watching', async () => {
    const e = events();
    const timers = new FakeTimers();
    let done = false;
    const p = tabLoaded(e.tabs, TAB, timers).then(() => { done = true; });
    expect(timers.delays()).toEqual([LOAD_MS]);
    e.update(8, 'complete');
    e.update(TAB, 'loading');
    await Promise.resolve();
    expect(done).toBe(false);
    e.update(TAB, 'complete');
    await p;
    expect(e.listeners.size).toBe(0);
    expect(timers.pending.size).toBe(0);
  });

  it('resolves after fifteen seconds when the load never completes', async () => {
    const e = events();
    const timers = new FakeTimers();
    const p = tabLoaded(e.tabs, TAB, timers);
    expect(LOAD_MS).toBe(15_000);
    timers.fire();
    await p;
    expect(e.listeners.size).toBe(0);
  });
});

describe('the place of a finding and of a connected place', () => {
  const changed = new Set(['src/file1.ts', 'src/lib.ts']);

  it('takes a finding’s kind from its anchor', () => {
    expect(ownPlace(finding(1), changed)).toEqual({ path: 'src/file1.ts', line: 10, kind: 'changed' });
    expect(ownPlace(finding(1, { anchor: { status: 'outside-diff', startLine: 40, endLine: 41 } }), changed))
      .toEqual({ path: 'src/file1.ts', line: 40, kind: 'outside' });
    expect(ownPlace(finding(1, { anchor: { status: 'not-found', startLine: null, endLine: null } }), changed))
      .toEqual({ path: 'src/file1.ts', line: null, kind: 'changed' });
    expect(ownPlace(finding(2, { anchor: { status: 'not-found', startLine: null, endLine: null } }), changed))
      .toEqual({ path: 'src/file2.ts', line: null, kind: 'elsewhere' });
    // An anchor in the changed lines is trusted, as the card trusts it.
    expect(ownPlace(finding(2), changed)).toEqual({ path: 'src/file2.ts', line: 20, kind: 'changed' });
  });

  it('takes a connected place’s kind from whether its path is among the files', () => {
    expect(connectedPlace({ path: 'src/lib.ts', line: 3, role: 'caller', quote: '' }, changed)).toEqual({ path: 'src/lib.ts', line: 3, kind: 'changed' });
    expect(connectedPlace({ path: 'src/other.ts', line: null, role: 'callee', quote: '' }, changed)).toEqual({ path: 'src/other.ts', line: null, kind: 'elsewhere' });
  });
});

describe('pageWords', () => {
  it('words each report for the Packs screen', () => {
    expect(pageWords(null)).toBe('No jump made yet.');
    expect(pageWords({ view: 'classic', missing: [] })).toBe('Recognised as the classic view.');
    expect(pageWords({ view: 'react', missing: [] })).toBe('Recognised as the newer view.');
    expect(pageWords({ view: null, missing: ['classic-file', 'react-file'] })).toBe('Not recognised. Selectors that found nothing: classic-file, react-file.');
    expect(pageWords({ view: 'react', missing: ['react-toolbar'] })).toBe('Recognised as the newer view. Selectors that found nothing: react-toolbar.');
  });
});
