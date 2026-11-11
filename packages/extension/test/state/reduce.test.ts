import { describe, expect, it } from 'vitest';
import type { Brief, ChangeMap, Dismissal, ServiceEvent } from '@airlock/shared';
import { NOTICE_MAX, clip, reduce, withStage, type PanelState, type StageLine } from '../../src/state/reduce';
import { STAGE_WORDS, stageWords } from '../../src/state/stage-words';
import { latestFor, prSummary } from '../helpers/fake-service';

const pr = prSummary();
const stage = (name: string, status: 'start' | 'done' | 'error', detail = ''): Extract<ServiceEvent, { type: 'stage' }> => ({
  type: 'stage', stage: name, status, detail,
});
const brief: Brief = { whatItDoes: ['Adds totals.'], claims: [] };
const map: ChangeMap = { cohorts: [], standalone: ['src/total.ts'], links: [] };

function dismissal(fingerprint: string): Dismissal {
  return {
    fingerprint, findingId: 'c_01234567', reviewId: 'r_0000000001', reason: 'not-now', text: '',
    at: '2026-11-11T10:00:00Z', learned: null,
  };
}

describe('stage words', () => {
  it('names every stage the engine emits in words, with the raw name as the fallback', () => {
    const engineStages = ['intake', 'packs', 'shape', 'facts', 'map', 'brief', 'lenses', 'sweep', 'seams', 'anchor', 'challenge', 'lenses-deep', 'select', 'store'];
    expect(Object.keys(STAGE_WORDS).sort()).toEqual([...engineStages].sort());
    for (const name of engineStages) {
      expect(stageWords(name)).not.toBe(name);
      expect(stageWords(name)).toMatch(/^[A-Z][a-z]/);
    }
    expect(stageWords('intake')).toBe('Reading the pull request');
    expect(stageWords('challenge')).toBe('Challenging every finding');
    expect(stageWords('select')).toBe('Ranking and picking the top five');
    expect(stageWords('toString')).toBe('toString');
  });
});

describe('withStage', () => {
  it('keeps one line per stage, in order of first appearance, with its latest status', () => {
    let lines: StageLine[] = [];
    lines = withStage(lines, stage('intake', 'start'));
    lines = withStage(lines, stage('shape', 'done', 'skipped: not a sync merge'));
    lines = withStage(lines, stage('intake', 'done', '3 files'));
    lines = withStage(lines, stage('lenses', 'error', 'timed out'));
    expect(lines).toEqual([
      { stage: 'intake', words: 'Reading the pull request', status: 'done', detail: '3 files' },
      { stage: 'shape', words: STAGE_WORDS.shape, status: 'skipped', detail: 'not a sync merge' },
      { stage: 'lenses', words: STAGE_WORDS.lenses, status: 'failed', detail: 'timed out' },
    ]);
  });
});

describe('reduce', () => {
  const running: PanelState = { kind: 'running', pr, stages: [], brief: null, map: null };

  it('replaces the stage list only while a review runs', () => {
    const lines = withStage([], stage('intake', 'start'));
    expect(reduce(running, { type: 'stages', stages: lines })).toEqual({ ...running, stages: lines });
    const ready: PanelState = { kind: 'ready', pr };
    expect(reduce(ready, { type: 'stages', stages: lines })).toBe(ready);
    expect(reduce(ready, { type: 'event', event: { type: 'brief', brief } })).toBe(ready);
  });

  it('a stored review is shown marked stale against the head; none is ready', () => {
    const loading: PanelState = { kind: 'loading' };
    expect(reduce(loading, { type: 'loaded', pr, latest: null })).toEqual({ kind: 'ready', pr });
    const old = latestFor(pr, 'd'.repeat(40));
    expect(reduce(loading, { type: 'loaded', pr, latest: old })).toEqual({ kind: 'review', pr, latest: old, stale: true });
  });

  it('marks ready and review busy while an action is in flight, and clears it', () => {
    const ready: PanelState = { kind: 'ready', pr };
    const busy = reduce(ready, { type: 'busy', busy: true });
    expect(busy).toEqual({ kind: 'ready', pr, busy: true });
    expect(reduce(busy, { type: 'busy', busy: false })).toEqual({ kind: 'ready', pr });
    expect('busy' in reduce(busy, { type: 'busy', busy: false })).toBe(false);
    expect(reduce(ready, { type: 'busy', busy: false })).toBe(ready);
    expect(reduce(running, { type: 'busy', busy: true })).toBe(running);
  });

  it('a refusal stays on the screen as a notice that the next success clears', () => {
    const latest = latestFor(pr);
    const review: PanelState = { kind: 'review', pr, latest, stale: false, busy: true };
    const refused = reduce(review, { type: 'refused', message: 'That finding is not in the stored review.' });
    expect(refused).toEqual({ kind: 'review', pr, latest, stale: false, notice: 'That finding is not in the stored review.' });
    const dismissed = reduce(refused, { type: 'dismissed', dismissal: dismissal('0123456789abcdef') });
    expect(dismissed).toEqual({ kind: 'review', pr, latest: { ...latest, dismissals: [dismissal('0123456789abcdef')] }, stale: false });
    expect(reduce({ kind: 'ready', pr }, { type: 'refused', message: 'Two reviews are already running.' })).toEqual({
      kind: 'ready', pr, notice: 'Two reviews are already running.',
    });
    expect(reduce(running, { type: 'refused', message: 'x' })).toBe(running);
  });

  it(`cuts text from the service to ${NOTICE_MAX} characters where it enters the state`, () => {
    const long = 'é'.repeat(400);
    const cut = `${'é'.repeat(NOTICE_MAX - 1)}…`;
    expect(clip(long)).toBe(cut);
    expect(clip('short')).toBe('short');
    expect(clip('a'.repeat(NOTICE_MAX))).toBe('a'.repeat(NOTICE_MAX));
    expect(reduce(running, { type: 'event', event: { type: 'failed', message: long } })).toMatchObject({ message: cut });
    expect(reduce({ kind: 'ready', pr }, { type: 'refused', message: long })).toMatchObject({ notice: cut });
    expect(reduce({ kind: 'unpaired' }, { type: 'unpaired', message: long })).toMatchObject({ message: cut });
    expect(reduce({ kind: 'loading' }, { type: 'problem', message: long })).toMatchObject({ message: cut });
    const review: PanelState = { kind: 'review', pr, latest: latestFor(pr), stale: false };
    expect(reduce(review, { type: 'restored', fingerprint: '0123456789abcdef', note: long })).toMatchObject({ notice: cut });
  });

  it('going offline keeps a review, or the brief and map of a running one, readable', () => {
    const latest = latestFor(pr);
    expect(reduce({ kind: 'review', pr, latest, stale: true, notice: 'n' }, { type: 'offline' })).toEqual({
      kind: 'offline', review: { pr, latest, stale: true },
    });
    expect(reduce({ ...running, brief, map, stages: withStage([], stage('intake', 'start')) }, { type: 'offline' })).toEqual({
      kind: 'offline', progress: { pr, brief, map },
    });
    const offline: PanelState = { kind: 'offline' };
    expect(reduce(offline, { type: 'offline' })).toBe(offline);
  });

  it('a failed review keeps only what it showed', () => {
    const withBrief = reduce({ ...running, brief }, { type: 'event', event: { type: 'failed', message: 'Stopped.' } });
    expect(withBrief).toEqual({ kind: 'problem', pr, message: 'Stopped.', brief });
    expect('map' in withBrief).toBe(false);
  });

  it('ignores results that do not apply', () => {
    expect(reduce({ kind: 'no-pr' }, { type: 'dismissed', dismissal: dismissal('0123456789abcdef') })).toEqual({ kind: 'no-pr' });
    const ready: PanelState = { kind: 'ready', pr };
    expect(reduce(ready, { type: 'finished', latest: latestFor(pr) })).toBe(ready);
  });
});
