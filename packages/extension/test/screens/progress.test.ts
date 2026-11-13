import { describe, expect, it } from 'vitest';
import { elapsedWords, filesAndGroups, prLine, progressOf, stepWords } from '../../src/screens/progress';
import { STAGE_WORDS } from '../../src/state/stage-words';
import { map } from './fixtures';

/** The engine's STAGES, in order (packages/engine/src/pipeline/stages.ts). */
const ENGINE_STAGES = ['intake', 'packs', 'shape', 'facts', 'map', 'brief', 'lenses', 'sweep', 'seams', 'anchor', 'merge', 'challenge', 'lenses-deep', 'select', 'summary', 'store'];
const line = (stage: string, status: 'working' | 'done' | 'failed' | 'skipped' = 'done') => ({ stage, words: stage, status, detail: '' });

describe('the stages the progress screen counts', () => {
  it('are the stage words, in the order the engine runs them', () => {
    expect(Object.keys(STAGE_WORDS)).toEqual(ENGINE_STAGES);
  });
  it('leave out the deep pass unless the review is deep', () => {
    expect(progressOf([], 'quick').total).toBe(15);
    expect(progressOf([], 'standard').total).toBe(15);
    expect(progressOf([], 'deep').total).toBe(16);
    expect(progressOf([]).total).toBeNull();
    expect(progressOf([], 'deep').rows.map((r) => r.stage)).toEqual(ENGINE_STAGES);
    expect(progressOf([], 'standard').rows.every((r) => r.word === 'Next')).toBe(true);
  });
  it('count each stage started, side by side or not, as one step', () => {
    const p = progressOf([line('intake'), line('lenses', 'working'), line('sweep', 'working')], 'standard');
    expect(p.step).toBe(3);
    expect(p.current).toBe('sweep');
    expect(progressOf([line('intake'), line('packs')], 'standard').current).toBe('packs');
  });
});

describe('words on the progress screen', () => {
  it('says the step with its total, or alone', () => {
    expect(stepWords({ step: 4, total: 15 })).toBe('Step 4 of 15');
    expect(stepWords({ step: 4, total: null })).toBe('Step 4');
  });
  it('says the time in seconds, minutes and seconds, or hours and minutes', () => {
    expect(elapsedWords(0)).toBe('0 s');
    expect(elapsedWords(59_999)).toBe('59 s');
    expect(elapsedWords(60_000)).toBe('1 min 0 s');
    expect(elapsedWords(130_000)).toBe('2 min 10 s');
    expect(elapsedWords(3_900_000)).toBe('1 h 5 min');
    expect(elapsedWords(-5)).toBe('0 s');
  });
  it('counts the files and groups of the map, each file once', () => {
    expect(filesAndGroups(null)).toBeNull();
    expect(filesAndGroups(map)).toBe('4 files in 2 groups');
    expect(filesAndGroups({ cohorts: [], standalone: [], links: [] })).toBeNull();
    expect(filesAndGroups({ cohorts: [], standalone: ['a.ts'], links: [] })).toBe('1 file');
    const one = map.cohorts[0]!;
    expect(filesAndGroups({ cohorts: [{ ...one, layers: [one.layers[0]!] }], standalone: ['db/001.sql'], links: [] })).toBe('1 file in 1 group');
  });
  it('says the pull request\'s repository, number, files and lines on one line', () => {
    expect(prLine({ repo: 'acme/widgets', number: 7, changedFiles: 14, additions: 612, deletions: 38 })).toBe('acme/widgets #7 · 14 files · 612 lines added, 38 removed');
    expect(prLine({ repo: 'acme/widgets', number: 7, changedFiles: 1, additions: 1, deletions: 1 })).toBe('acme/widgets #7 · 1 file · 1 line added, 1 removed');
  });
});
