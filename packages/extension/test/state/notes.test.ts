import { afterEach, describe, expect, it } from 'vitest';
import { diffAnchorId, type Finding, type LatestReply, type PostRecord, type PrSummary } from '@airlock/shared';
import { ServiceClient } from '../../src/client/service';
import type { ClearNotesMessage, NotesMessage } from '../../src/page/protocol';
import { startPanel } from '../../src/state/machine';
import type { NotesResult } from '../../src/state/jump';
import {
  COULD_NOT_REACH_PAGE, RECHECK_FOR_MS, RECHECK_MS, notesFor, notesLine, noteTitle, startNotes, type NotesLine,
} from '../../src/state/notes';
import type { PanelState, ReviewView } from '../../src/state/reduce';
import type { SettingsStore } from '../../src/state/settings';
import type { TabWatcher } from '../../src/state/tab';
import { BASE, FakeService, TOKEN, held, json, latestFor, prSummary, prUrl } from '../helpers/fake-service';
import { FakeTimers } from '../helpers/fake-timers';
import { recordOf } from '../helpers/post-fixtures';
import { also, dismissal, finding } from '../screens/review-fixtures';

const FILES = prUrl('acme/widgets', 1, '/files');
const anchor = (path: string): Promise<string> => diffAnchorId(path);

function memorySettings(showNotes: boolean | 'fails' = true): SettingsStore & { stored: boolean | null } {
  return {
    stored: null,
    async getToken() { return TOKEN; },
    async setToken() {},
    async getDefaultDepth() { return null; },
    async setDefaultDepth() {},
    async getShowNotes() { return showNotes !== false; },
    async setShowNotes(on) {
      if (showNotes === 'fails') throw new Error('storage is full');
      this.stored = on;
    },
  };
}

type FakeTab = TabWatcher & { go(url: string | undefined, status?: string): void };

function fakeTab(start: string | undefined): FakeTab {
  const listeners = new Set<(url: string | undefined, status?: string) => void>();
  let url = start;
  return {
    current: async () => ({ tabId: 3, url }),
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    go(next, status) {
      url = next;
      for (const fn of listeners) fn(next, status);
    },
  };
}

interface Sent { tabId: number; message: NotesMessage | ClearNotesMessage; reload: boolean }

/** What the page answers when nothing else is scripted: every note placed, and nothing held for a clear message. */
const placedAll = (m: NotesMessage | ClearNotesMessage): NotesResult => (m.type === 'airlock:notes'
  ? { kind: 'shown', placed: m.notes.length, waiting: 0, view: 'classic', missing: [] }
  : { kind: 'shown', placed: 0, waiting: 0, view: null, missing: [] });

const stops: { stop(): void }[] = [];
afterEach(() => { for (const s of stops.splice(0)) s.stop(); });

/** The panel's machine with its notes beside a tab, against the fake service; every message the notes send. */
function setup(opts: {
  url?: string; latest?: LatestReply | null; pr?: PrSummary; show?: boolean | 'fails'; answers?: NotesResult[];
  /** The page's answer once the scripted ones are used up; every note placed unless given. */
  otherwise?: (m: NotesMessage | ClearNotesMessage) => NotesResult;
} = {}) {
  const svc = new FakeService();
  const pr = opts.pr ?? prSummary();
  svc.addPr(pr);
  if (opts.latest !== null) svc.latest.set(`${pr.repo}#${pr.number}`, opts.latest ?? latestFor(pr));
  const settings = memorySettings(opts.show);
  const client = new ServiceClient(BASE, () => settings.getToken(), svc.fetch, new FakeTimers(), () => 0);
  const tab = fakeTab('url' in opts ? opts.url : FILES);
  const sent: Sent[] = [];
  const answers = [...(opts.answers ?? [])];
  // The notes' own clock and timers (the rechecks), apart from the machine's.
  const timers = new FakeTimers();
  const clock = { now: Date.parse('2026-11-12T10:00:00.000Z') };
  const notes = startNotes({
    tab, settings, timers, now: () => clock.now,
    send: async (tabId, message, { reload }) => {
      sent.push({ tabId, message, reload });
      return answers.shift() ?? (opts.otherwise ?? placedAll)(message);
    },
  });
  const lines: (NotesLine | null)[] = [];
  notes.subscribe((s) => lines.push(s.line));
  const states: PanelState[] = [];
  const panel = startPanel({ client, tab, settings, timers: new FakeTimers(), notes, onState: (s) => states.push(s) });
  stops.push(panel, notes);
  return { svc, settings, tab, sent, notes, lines, states, panel, timers, clock, last: () => states.at(-1) };
}

async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (check()) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error(`waited for ${what}`);
}
/** Lets every pending step run; for asserting that nothing more is sent. */
async function settle(): Promise<void> {
  for (let i = 0; i < 40; i++) await new Promise((r) => setImmediate(r));
}

function review(findings: Finding[], over: { dismissals?: LatestReply['dismissals']; posts?: PostRecord[]; fixed?: Finding[]; head?: string } = {}): LatestReply {
  const pr = prSummary();
  const latest = latestFor(pr, over.head ?? pr.headSha);
  return {
    document: { ...latest.document, findings, ...(over.fixed === undefined ? {} : { fixed: over.fixed }) },
    dismissals: over.dismissals ?? [], posts: over.posts ?? [],
  };
}

const notesSent = (s: Sent): NotesMessage => {
  if (s.message.type !== 'airlock:notes') throw new Error(`expected notes, sent ${JSON.stringify(s.message)}`);
  return s.message;
};

describe('the notes the panel sends', () => {
  it('sends notes for open findings with a line and leaves out dismissed, fixed and unanchored ones', async () => {
    const top1 = finding(1, { severity: 'block', path: 'src/pause.ts', anchor: { status: 'in-diff', startLine: 11, endLine: 11 } });
    // Dismissed under one of its aliases.
    const top2 = finding(2, { aliases: ['a'.repeat(16)] });
    const noLine = finding(3, { anchor: { status: 'not-found', startLine: null, endLine: null } });
    const posted = finding(4, { path: 'src/guard.ts', anchor: { status: 'in-diff', startLine: 4, endLine: 4 } });
    // Outside the changed lines: sent, and the page keeps it waiting.
    const outside = also(5, { path: 'src/pause.ts', anchor: { status: 'outside-diff', startLine: 40, endLine: 40 } });
    // Still in the findings, and in the document's list of findings fixed since the last review.
    const fixedOne = finding(6, { status: 'still-open' });
    const latest = review([outside, posted, noLine, top2, top1, fixedOne], {
      dismissals: [dismissal(top2, { fingerprint: 'a'.repeat(16) })],
      posts: [recordOf([posted.fingerprint])],
      fixed: [finding(7, { status: 'fixed', fingerprint: fixedOne.fingerprint, bucket: 'also', rank: null })],
    });
    const h = setup({ latest });
    await until(() => h.sent.length === 1, 'the notes');
    expect(h.sent[0]!.tabId).toBe(3);
    expect(h.sent[0]!.reload).toBe(false);
    expect(notesSent(h.sent[0]!)).toEqual({
      type: 'airlock:notes', pr: { repo: 'acme/widgets', number: 1 },
      notes: [
        { id: top1.id, anchorId: await anchor('src/pause.ts'), line: 11, severity: 'block', title: top1.title },
        { id: posted.id, anchorId: await anchor('src/guard.ts'), line: 4, severity: 'fix', title: posted.title },
        { id: outside.id, anchorId: await anchor('src/pause.ts'), line: 40, severity: 'note', title: outside.title },
      ],
    });
    await until(() => h.lines.at(-1)?.text === '3 notes shown in the diff', 'the line');
    // Nothing changed: nothing is sent again.
    await settle();
    expect(h.sent).toHaveLength(1);
  });

  it('sends at most 60, top five first, cuts a long title, and says when it left some out', async () => {
    const top = [1, 2, 3, 4, 5].map((n) => finding(n));
    const many = Array.from({ length: 70 }, (_, i) => also(10 + i));
    const long = 'x'.repeat(250);
    const view: ReviewView = {
      pr: prSummary(), stale: false,
      latest: review([...many, ...top.slice(0, 4), { ...top[4]!, title: long }]),
    };
    const { message, left } = await notesFor(view);
    expect(message.notes).toHaveLength(60);
    expect(message.notes.slice(0, 5).map((n) => n.id)).toEqual(top.map((f) => f.id));
    expect(message.notes[5]!.id).toBe(many[0]!.id);
    expect(left).toBe(15);
    expect(message.notes[4]!.title).toBe(`${'x'.repeat(199)}…`);
    expect(message.notes[4]!.title).toHaveLength(200);
    expect(notesLine({ kind: 'shown', placed: 60, waiting: 0, view: 'classic', missing: [] }, left)).toEqual({
      text: '60 notes shown in the diff (the first 60 findings)', reload: false,
    });
  });

  it('cuts a title without splitting a character, and leaves out a finding whose id the page would refuse', async () => {
    const emoji = '😀'.repeat(150);
    expect(noteTitle(emoji)).toBe(`${'😀'.repeat(99)}…`);
    expect(noteTitle(emoji).length).toBeLessThanOrEqual(200);
    expect(noteTitle('Short')).toBe('Short');
    const view: ReviewView = { pr: prSummary(), stale: false, latest: review([finding(1, { id: 'c1' }), finding(2)]) };
    expect((await notesFor(view)).message.notes.map((n) => n.id)).toEqual([finding(2).id]);
  });

  it('sends again after a dismissal and after a restore', async () => {
    const one = finding(1);
    const two = finding(2);
    const h = setup({ latest: review([one, two]) });
    await until(() => h.sent.length === 1, 'the notes');
    expect(notesSent(h.sent[0]!).notes.map((n) => n.id)).toEqual([one.id, two.id]);

    h.svc.on('POST /dismissals', () => json(dismissal(one, { reason: 'not-now' })));
    h.panel.dispatch({ type: 'dismiss', body: { repo: 'acme/widgets', number: 1, reviewId: 'r_0000000001', findingId: one.id, reason: 'not-now', text: '' } });
    await until(() => h.sent.length === 2, 'the notes after the dismissal');
    expect(notesSent(h.sent[1]!).notes.map((n) => n.id)).toEqual([two.id]);
    await until(() => h.lines.at(-1)?.text === '1 note shown in the diff', 'the line');

    h.svc.on('POST /dismissals/restore', () => json({ restored: true, note: null }));
    h.panel.dispatch({ type: 'restore', fingerprint: one.fingerprint });
    await until(() => h.sent.length === 3, 'the notes after the restore');
    expect(notesSent(h.sent[2]!).notes.map((n) => n.id)).toEqual([one.id, two.id]);
  });

  it('clears the notes when the setting is turned off, when the review is stale and when the panel shows no review', async () => {
    const h = setup({ latest: review([finding(1)]) });
    await until(() => h.sent.length === 1, 'the notes');
    h.notes.setShown(false);
    await until(() => h.sent.length === 2, 'the clear message');
    expect(h.sent[1]!.message).toEqual({ type: 'airlock:notes-clear' });
    expect(h.settings.stored).toBe(false);
    expect(h.notes.current().on).toBe(false);
    expect(h.lines.at(-1)).toBeNull();
    h.notes.setShown(true);
    await until(() => h.sent.length === 3, 'the notes again');
    expect(notesSent(h.sent[2]!).notes).toHaveLength(1);

    // A review of an older commit than the head: its lines may have moved.
    const stale = setup({ latest: review([finding(1)], { head: 'd'.repeat(40) }) });
    await until(() => stale.last()?.kind === 'review', 'the stale review');
    await until(() => stale.sent.length === 1, 'the clear message');
    expect(stale.sent[0]!.message).toEqual({ type: 'airlock:notes-clear' });

    // No review on screen: Ready (nothing stored), and a review that starts running.
    const ready = setup({ latest: null });
    await until(() => ready.last()?.kind === 'ready', 'Ready');
    await until(() => ready.sent.length === 1, 'the clear message');
    expect(ready.sent[0]!.message).toEqual({ type: 'airlock:notes-clear' });
    // Already cleared: Ready again sends nothing more.
    ready.tab.go(FILES, 'complete');
    await settle();
    expect(ready.sent).toHaveLength(1);

    const running = setup({ latest: review([finding(1)]) });
    await until(() => running.sent.length === 1, 'the notes');
    running.panel.dispatch({ type: 'start', depth: 'quick' });
    await until(() => running.last()?.kind === 'running', 'running');
    await until(() => running.sent.length === 2, 'the clear message');
    expect(running.sent[1]!.message).toEqual({ type: 'airlock:notes-clear' });
  });

  it('a setting that cannot be stored is undone and said', async () => {
    const h = setup({ latest: review([finding(1)]), show: 'fails' });
    await until(() => h.sent.length === 1, 'the notes');
    h.notes.setShown(false);
    await until(() => h.notes.current().failed, 'the failure');
    expect(h.notes.current().on).toBe(true);
    await settle();
    // Briefly off and back on: the page ends with the notes.
    expect(h.sent.at(-1)!.message.type).toBe('airlock:notes');
  });

  it('sends nothing to a tab that is not that pull request\'s Files changed view, and sends when it gets there', async () => {
    const h = setup({ url: prUrl('acme/widgets', 1), latest: review([finding(1)]) });
    await until(() => h.last()?.kind === 'review', 'the review');
    await settle();
    expect(h.sent).toEqual([]);
    h.tab.go(prUrl('acme/widgets', 1, '/commits'));
    h.tab.go(prUrl('acme/widgets', 1, '/files/0123456..89abcde'));
    // One commit's diff in the newer view: its lines are not the head's.
    h.tab.go(prUrl('acme/widgets', 1, `/changes/${'a'.repeat(40)}`));
    await settle();
    expect(h.sent).toEqual([]);
    expect(h.lines.filter((l) => l !== null)).toEqual([]);

    h.tab.go(FILES);
    await until(() => h.sent.length === 1, 'the notes');
    expect(notesSent(h.sent[0]!).pr).toEqual({ repo: 'acme/widgets', number: 1 });
    // A fragment is a new address: the page may have been left and come back, so the notes are sent again.
    h.tab.go(`${FILES}#diff-abc`);
    await until(() => h.sent.length === 2, 'the notes again');
    // An update to the same address sends again only when the page finished loading (a reload starts it empty).
    h.tab.go(`${FILES}#diff-abc`);
    await settle();
    expect(h.sent).toHaveLength(2);
    h.tab.go(`${FILES}#diff-abc`, 'complete');
    await until(() => h.sent.length === 3, 'the notes after a reload');
    // Leaving the view takes the line away.
    h.tab.go(prUrl('acme/widgets', 1));
    await until(() => h.lines.at(-1) === null, 'no line');
    expect(h.sent).toHaveLength(3);
  });

  it('a tab with no page script gets the reload sentence and button once, and the tab is reloaded only when asked', async () => {
    const h = setup({ latest: review([finding(1)]), answers: [{ kind: 'unreached' }] });
    await until(() => h.lines.at(-1)?.text === COULD_NOT_REACH_PAGE, 'the reload sentence');
    expect(h.lines.at(-1)).toEqual({ text: 'Airlock could not reach the GitHub page. Reload it, then try again.', reload: true });
    expect(h.sent.map((s) => s.reload)).toEqual([false]);
    // The same notes are not sent again by themselves.
    h.tab.go(FILES);
    await settle();
    expect(h.sent).toHaveLength(1);
    h.notes.reload();
    await until(() => h.sent.length === 2, 'the reload');
    expect(h.sent[1]!.reload).toBe(true);
    await until(() => h.lines.at(-1)?.text === '1 note shown in the diff', 'the line');
  });
});

const viewOf = (s: PanelState | undefined): ReviewView => {
  if (s?.kind !== 'review') throw new Error(`no review on screen: ${JSON.stringify(s)}`);
  return { pr: s.pr, latest: s.latest, stale: s.stale };
};
const shownOf = (placed: number, waitingFor: number): NotesResult => ({ kind: 'shown', placed, waiting: waitingFor, view: 'classic', missing: [] });
const waiting = (m: NotesMessage | ClearNotesMessage): NotesResult => (m.type === 'airlock:notes'
  ? { kind: 'shown', placed: 0, waiting: m.notes.length, view: 'classic', missing: [] }
  : placedAll(m));

describe('the notes the panel sends: follow-ups', () => {
  it('sends nothing on a loading update, at the same address or a new one; the complete update sends', async () => {
    const h = setup({ latest: review([finding(1)]) });
    await until(() => h.sent.length === 1, 'the notes');
    // A full reload of the same page, and a full load of the page with a fragment: no script answers while they load.
    h.tab.go(FILES, 'loading');
    h.tab.go(`${FILES}#diff-abc`, 'loading');
    await settle();
    expect(h.sent).toHaveLength(1);
    expect(h.lines.at(-1)?.text).toBe('1 note shown in the diff');
    h.tab.go(`${FILES}#diff-abc`, 'complete');
    await until(() => h.sent.length === 2, 'the notes once loaded');
    // A change of address with no status (a move within the page) still sends.
    h.tab.go(`${FILES}#diff-def`);
    await until(() => h.sent.length === 3, 'the notes after a move');
  });

  it('a page that starts loading stops a recheck, and gets nothing until it is complete', async () => {
    const h = setup({ latest: review([finding(1)]), otherwise: (m) => (m.type === 'airlock:notes' ? waiting(m) : placedAll(m)) });
    await until(() => h.timers.delays().length === 1, 'a recheck');
    h.tab.go(FILES, 'loading');
    expect(h.timers.delays()).toEqual([]);
    await settle();
    expect(h.sent).toHaveLength(1);
    h.tab.go(FILES, 'complete');
    await until(() => h.sent.length === 2, 'the notes once loaded');
  });

  it('a forced resend is never dropped when another update starts while it builds its notes', async () => {
    const h = setup({ latest: review([finding(1)]) });
    await until(() => h.sent.length === 1, 'the notes');
    const view = viewOf(h.last());
    // Reload, then at once an update with the same notes (as a machine state with nothing new does).
    h.notes.reload();
    h.notes.review(view);
    await until(() => h.sent.length === 2, 'the reload');
    expect(h.sent[1]!.reload).toBe(true);
    // The same for a page that finished loading again at the same address.
    h.tab.go(FILES, 'complete');
    h.notes.review(view);
    await until(() => h.sent.length === 3, 'the notes after the reload');
    expect(h.sent[2]!.reload).toBe(false);
    await settle();
    expect(h.sent).toHaveLength(3);
  });

  it('while notes wait, sends the same notes every 3 seconds for at most a minute, and the line follows the page', async () => {
    const w = setup({ latest: review([finding(1), finding(2)]), otherwise: (m) => (m.type === 'airlock:notes' ? shownOf(1, 1) : placedAll(m)) });
    await until(() => w.lines.at(-1)?.text === '1 shown, 1 waiting for their lines to load', 'the waiting line');
    expect(RECHECK_MS).toBe(3_000);
    expect(w.timers.delays()).toEqual([RECHECK_MS]);
    // The same answer again: the same notes, no change to the line (so nothing is said again).
    const lines = w.lines.length;
    for (let i = 0; i < 3; i++) {
      w.clock.now += RECHECK_MS;
      w.timers.fire();
      await until(() => w.sent.length === i + 2, 'a recheck');
    }
    expect(w.sent.every((s) => JSON.stringify(s.message) === JSON.stringify(w.sent[0]!.message) && !s.reload)).toBe(true);
    expect(w.lines.length).toBe(lines);
    // At most a minute after the first answer that said notes wait.
    expect(RECHECK_FOR_MS).toBe(60_000);
    for (let i = 0; i < 30 && w.timers.delays().length > 0; i++) {
      w.clock.now += RECHECK_MS;
      w.timers.fire();
      await settle();
    }
    expect(w.sent).toHaveLength(1 + RECHECK_FOR_MS / RECHECK_MS);
    expect(w.timers.delays()).toEqual([]);
  });

  it('stops rechecking when the notes are all placed, when the list changes and when the tab leaves the view', async () => {
    let placed = false;
    const h = setup({ latest: review([finding(1), finding(2)]), otherwise: (m) => (m.type === 'airlock:notes' && !placed ? waiting(m) : placedAll(m)) });
    await until(() => h.lines.at(-1)?.text === '0 shown, 2 waiting for their lines to load', 'the waiting line');
    // GitHub loaded the lines: the next recheck finds them placed, and the rechecks end.
    placed = true;
    h.clock.now += RECHECK_MS;
    h.timers.fire();
    await until(() => h.lines.at(-1)?.text === '2 notes shown in the diff', 'the placed line');
    expect(h.timers.delays()).toEqual([]);

    // A new list: the recheck of the old one ends, and the new list is sent at once.
    placed = false;
    h.tab.go(`${FILES}#a`);
    await until(() => h.timers.delays().length === 1, 'a recheck');
    h.svc.on('POST /dismissals', () => json(dismissal(finding(1), { reason: 'not-now' })));
    h.panel.dispatch({ type: 'dismiss', body: { repo: 'acme/widgets', number: 1, reviewId: 'r_0000000001', findingId: finding(1).id, reason: 'not-now', text: '' } });
    await until(() => notesSent(h.sent.at(-1)!).notes.length === 1, 'the new list');
    const sends = h.sent.length;
    // Leaving the view: no more rechecks.
    h.tab.go(prUrl('acme/widgets', 1));
    await until(() => h.lines.at(-1) === null, 'no line');
    expect(h.timers.delays()).toEqual([]);
    expect(h.sent).toHaveLength(sends);
  });

  it('another pull request\'s Files changed page gets no notes', async () => {
    const tab = fakeTab(prUrl('acme/widgets', 2, '/files'));
    const sent: Sent[] = [];
    const notes = startNotes({ tab, settings: memorySettings(), send: async (tabId, message, { reload }) => { sent.push({ tabId, message, reload }); return placedAll(message); } });
    stops.push(notes);
    const view: ReviewView = { pr: prSummary(), stale: false, latest: review([finding(1)]) };
    notes.review(view);
    await settle();
    tab.go(prUrl('acme/gadgets', 1, '/files'), 'complete');
    tab.go(prUrl('ACME/widgets', 10, '/files'), 'complete');
    await settle();
    expect(sent).toEqual([]);
    tab.go(prUrl('ACME/widgets', 1, '/files'), 'complete');
    await until(() => sent.length === 1, 'the notes');
  });

  it('a tab that could not be read at the start is read again on the next change, and the setting works meanwhile', async () => {
    for (const next of ['review', 'tab update'] as const) {
      let reads = 0;
      const tab = fakeTab(FILES);
      const read = tab.current;
      tab.current = async () => {
        reads += 1;
        if (reads === 1) throw new Error('No tab with id 3');
        return read();
      };
      const sent: Sent[] = [];
      const notes = startNotes({ tab, settings: memorySettings(), send: async (tabId, message, { reload }) => { sent.push({ tabId, message, reload }); return placedAll(message); } });
      stops.push(notes);
      const view: ReviewView = { pr: prSummary(), stale: false, latest: review([finding(1)]) };
      await settle();
      expect(notes.current().on, next).toBe(true);
      expect(reads).toBe(1);
      if (next === 'tab update') {
        tab.go(FILES, 'complete');
        await settle();
        expect(reads).toBe(2);
      }
      notes.review(view);
      await until(() => sent.length === 1, `the notes after a ${next}`);
      expect(reads).toBe(2);
    }
  });

  it('a recheck window starts again when the page loads again and when the address changes', async () => {
    const h = setup({ latest: review([finding(1)]), otherwise: (m) => (m.type === 'airlock:notes' ? waiting(m) : placedAll(m)) });
    await until(() => h.timers.delays().length === 1, 'a recheck');
    // The whole minute passes with the notes still waiting: the rechecks end.
    for (let i = 0; i < 30 && h.timers.delays().length > 0; i++) {
      h.clock.now += RECHECK_MS;
      h.timers.fire();
      await settle();
    }
    expect(h.timers.delays()).toEqual([]);
    // The person reloads the tab: the same notes, and a new minute of rechecks.
    h.tab.go(FILES, 'loading');
    h.tab.go(FILES, 'complete');
    await until(() => h.timers.delays().length === 1, 'a recheck after the reload');
    for (let i = 0; i < 30 && h.timers.delays().length > 0; i++) {
      h.clock.now += RECHECK_MS;
      h.timers.fire();
      await settle();
    }
    expect(h.timers.delays()).toEqual([]);
    // Away to the conversation and back: a new minute again.
    h.tab.go(prUrl('acme/widgets', 1));
    h.tab.go(FILES);
    await until(() => h.timers.delays().length === 1, 'a recheck after coming back');
  });

  it('a page that recognises no view yet is asked again, and the cannot-be-shown sentence waits for the end of the minute', async () => {
    let rendered = false;
    const unknown = (m: NotesMessage | ClearNotesMessage): NotesResult => (m.type === 'airlock:notes'
      ? (rendered ? placedAll(m) : { kind: 'shown', placed: 0, waiting: m.notes.length, view: null, missing: ['classic-file', 'react-file', 'react-toolbar'] })
      : placedAll(m));
    const h = setup({ latest: review([finding(1), finding(2)]), otherwise: unknown });
    await until(() => h.timers.delays().length === 1, 'a recheck');
    expect(h.lines.at(-1)?.text).toBe('0 shown, 2 waiting for their lines to load');
    // GitHub renders the files: the next recheck places the notes.
    rendered = true;
    h.clock.now += RECHECK_MS;
    h.timers.fire();
    await until(() => h.lines.at(-1)?.text === '2 notes shown in the diff', 'the placed line');
    expect(h.lines.some((l) => l?.text.startsWith('Notes cannot be shown'))).toBe(false);

    // A page that never renders a view: the sentence once the minute is over, and not before.
    rendered = false;
    const n = setup({ latest: review([finding(1)]), otherwise: unknown });
    await until(() => n.timers.delays().length === 1, 'a recheck');
    for (let i = 0; i < 30 && n.timers.delays().length > 0; i++) {
      expect(n.lines.at(-1)?.text).toBe('0 shown, 1 waiting for their lines to load');
      n.clock.now += RECHECK_MS;
      n.timers.fire();
      await settle();
    }
    expect(n.timers.delays()).toEqual([]);
    expect(n.lines.at(-1)?.text).toBe("Notes cannot be shown on this version of GitHub's page (classic-file, react-file, react-toolbar). Jump to line still works.");
  });

  it('gives what the page recognised to the panel\'s state, for the Packs screen, and not a clear message\'s answer', async () => {
    const h = setup({
      latest: review([finding(1), finding(2)]),
      otherwise: (m) => (m.type === 'airlock:notes' ? { kind: 'shown', placed: 0, waiting: 2, view: 'react', missing: ['react-row'] } : placedAll(m)),
    });
    await until(() => h.notes.current().page !== undefined, 'the report');
    expect(h.notes.current().page).toEqual({ view: 'react', missing: ['react-row'] });
    h.notes.setShown(false);
    await until(() => h.sent.at(-1)?.message.type === 'airlock:notes-clear', 'the clear message');
    await settle();
    expect(h.notes.current().page).toEqual({ view: 'react', missing: ['react-row'] });
  });

  it('a refusal from the page reaches the line', async () => {
    const h = setup({ latest: review([finding(1)]), answers: [{ kind: 'refused', sentence: "The page refused Airlock's notes: a line is not a positive whole number." }] });
    await until(() => h.lines.at(-1)?.text === "The page refused Airlock's notes: a line is not a positive whole number.", 'the refusal');
    expect(h.lines.at(-1)?.reload).toBe(false);
  });
});

describe('the notes after the GitHub tab loads again', () => {
  const MOVED = 'd'.repeat(40);

  it('a push since the review: the pull request is read again, a clear is sent and no notes', async () => {
    const h = setup({ latest: review([finding(1)]) });
    await until(() => h.sent.length === 1, 'the notes');
    const reads = () => h.svc.calls.filter((c) => c === 'GET /pr').length;
    const before = reads();
    // The author pushed B; the person reloads the tab, which finishes loading at the same address.
    h.svc.addPr(prSummary({ headSha: MOVED }));
    h.tab.go(FILES, 'loading');
    h.tab.go(FILES, 'complete');
    await until(() => h.last()?.kind === 'review' && viewOf(h.last()).stale, 'the review known as stale');
    await until(() => h.sent.length === 2, 'the clear message');
    await settle();
    expect(reads()).toBe(before + 1);
    expect(h.sent.slice(1).map((s) => s.message)).toEqual([{ type: 'airlock:notes-clear' }]);
    expect(h.lines.at(-1)).toBeNull();
  });

  it('no push: the notes are sent once, after the read', async () => {
    const h = setup({ latest: review([finding(1)]) });
    await until(() => h.sent.length === 1, 'the notes');
    const read = held();
    h.svc.on('GET /pr', read.reply);
    const shown = h.states.length;
    h.tab.go(FILES, 'loading');
    h.tab.go(FILES, 'complete');
    await until(read.asked, 'the read');
    await settle();
    expect(h.sent).toHaveLength(1);
    read.release(json(prSummary()));
    await until(() => h.sent.length === 2, 'the notes after the read');
    await settle();
    expect(h.sent).toHaveLength(2);
    expect(notesSent(h.sent[1]!).notes).toHaveLength(1);
    // The same answer: nothing on screen changed.
    expect(h.states).toHaveLength(shown);
  });

  it('a read that fails: the notes are not sent and the page is cleared', async () => {
    const h = setup({ latest: review([finding(1)]) });
    await until(() => h.sent.length === 1, 'the notes');
    h.svc.on('GET /pr', () => json({ error: 'GitHub did not answer.' }, 502));
    h.tab.go(FILES, 'loading');
    h.tab.go(FILES, 'complete');
    await until(() => h.sent.length === 2, 'the clear message');
    await settle();
    expect(h.sent.slice(1).map((s) => s.message)).toEqual([{ type: 'airlock:notes-clear' }]);
    // Quiet: the review stays on screen.
    expect(h.last()?.kind).toBe('review');
  });

  it('a running review is left alone: no read, and nothing changes on screen', async () => {
    const h = setup({ latest: review([finding(1)]) });
    await until(() => h.sent.length === 1, 'the notes');
    h.panel.dispatch({ type: 'start', depth: 'quick' });
    await until(() => h.last()?.kind === 'running', 'running');
    const reads = h.svc.calls.filter((c) => c === 'GET /pr').length;
    const shown = h.states.length;
    h.tab.go(FILES, 'complete');
    await settle();
    expect(h.svc.calls.filter((c) => c === 'GET /pr').length).toBe(reads);
    expect(h.states).toHaveLength(shown);
  });
});

describe('the line under the verdict', () => {
  const shown = (placed: number, waiting: number, view: 'classic' | 'react' | null = 'classic', missing: string[] = []): NotesResult =>
    ({ kind: 'shown', placed, waiting, view, missing });

  it('shows the placed and waiting counts, and the missing selectors when the view is not recognised', () => {
    expect(notesLine(shown(3, 0), 0)).toEqual({ text: '3 notes shown in the diff', reload: false });
    expect(notesLine(shown(1, 0), 0)).toEqual({ text: '1 note shown in the diff', reload: false });
    expect(notesLine(shown(2, 3), 0)).toEqual({ text: '2 shown, 3 waiting for their lines to load', reload: false });
    expect(notesLine(shown(0, 60, 'react'), 4)).toEqual({ text: '0 shown, 60 waiting for their lines to load (the first 60 findings)', reload: false });
    // A view recognised with its files container missing still places notes: the counts are what matters.
    expect(notesLine(shown(2, 0, 'react', ['react-files']), 0)).toEqual({ text: '2 notes shown in the diff', reload: false });
    expect(notesLine(shown(0, 2, null, ['classic-file', 'react-file', 'react-toolbar']), 0)).toEqual({
      text: "Notes cannot be shown on this version of GitHub's page (classic-file, react-file, react-toolbar). Jump to line still works.",
      reload: false,
    });
    // A page still being asked whether it has a view: its notes wait.
    expect(notesLine(shown(0, 2, null, ['classic-file', 'react-file', 'react-toolbar']), 0, true)).toEqual({
      text: '0 shown, 2 waiting for their lines to load', reload: false,
    });
    // A recognised view whose rows are not found: nothing can be placed, and the selectors are named.
    expect(notesLine(shown(0, 2, 'react', ['react-row']), 0)).toEqual({
      text: "Notes cannot be shown on this version of GitHub's page (react-row). Jump to line still works.", reload: false,
    });
    expect(notesLine(shown(0, 2, 'react', ['react-files', 'react-row', 'react-line-number']), 0)).toEqual({
      text: "Notes cannot be shown on this version of GitHub's page (react-row, react-line-number). Jump to line still works.", reload: false,
    });
    // Only the files container missing, or a note placed: the counts.
    expect(notesLine(shown(0, 2, 'react', ['react-files']), 0)).toEqual({ text: '0 shown, 2 waiting for their lines to load', reload: false });
    expect(notesLine(shown(1, 1, 'react', ['react-row']), 0)).toEqual({ text: '1 shown, 1 waiting for their lines to load', reload: false });
    // No notes to show, or the page was not the Files changed view: no line.
    expect(notesLine(shown(0, 0), 0)).toBeNull();
    expect(notesLine(shown(0, 0, null), 0)).toBeNull();
    expect(notesLine({ kind: 'refused', sentence: "The page refused Airlock's notes: more than 60 notes." }, 0))
      .toEqual({ text: "The page refused Airlock's notes: more than 60 notes.", reload: false });
    expect(notesLine({ kind: 'unreached' }, 0)).toEqual({ text: COULD_NOT_REACH_PAGE, reload: true });
    expect(notesLine({ kind: 'gone' }, 0)).toBeNull();
  });
});
