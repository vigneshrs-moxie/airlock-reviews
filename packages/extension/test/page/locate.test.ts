// @vitest-environment happy-dom
import { diffAnchorId } from '@airlock/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { detectView, findFile, findLine, targetsOf } from '../../src/page/locate';
import { CLASSIC, REACT, missingFor } from '../../src/page/selectors';
import { CLASSIC_HTML, GUARD, PAUSE, REACT_HTML, load, splitGuard } from './page-fixtures';

afterEach(() => { document.documentElement.innerHTML = '<head></head><body></body>'; });

const codeOf = (row: HTMLElement | null): string | undefined =>
  row?.querySelector('.blob-code-inner, .diff-text-inner')?.textContent ?? undefined;

describe('the fixtures', () => {
  it('name each file by the SHA-256 of its path', async () => {
    expect(await diffAnchorId('src/pause.ts')).toBe(PAUSE);
    expect(await diffAnchorId('src/guard.ts')).toBe(GUARD);
  });
});

describe('every selector has a name', () => {
  it('for both views, and the names are distinct', () => {
    const all = [...Object.values(CLASSIC), ...Object.values(REACT)];
    expect(all.length).toBe(8);
    for (const s of all) {
      expect(s.name).not.toBe('');
      expect(() => document.querySelector(s.css)).not.toThrow();
    }
    expect(new Set(all.map((s) => s.name)).size).toBe(all.length);
  });
});

describe('detectView', () => {
  it('recognises the classic view and the newer view, and neither on another page', () => {
    load(CLASSIC_HTML);
    expect(detectView(document)).toBe('classic');
    load(REACT_HTML);
    expect(detectView(document)).toBe('react');
    load('<head></head><body><p>A conversation page.</p></body>');
    expect(detectView(document)).toBeNull();
  });

  it('recognises the newer view by its toolbar alone, or by a file container alone', () => {
    load(REACT_HTML);
    document.querySelector('[data-testid="progressive-diffs-list"]')!.remove();
    expect(detectView(document)).toBe('react');
    load(REACT_HTML);
    document.querySelector('section')!.remove();
    expect(detectView(document)).toBe('react');
  });
});

describe('missingFor', () => {
  it('names nothing on a page that matches every selector of its view', () => {
    load(CLASSIC_HTML);
    expect(missingFor(document, 'classic')).toEqual([]);
    load(REACT_HTML);
    expect(missingFor(document, 'react')).toEqual([]);
  });

  it('names the selectors of the detected view that found nothing', () => {
    load(REACT_HTML);
    document.querySelector('section')!.remove();
    expect(missingFor(document, 'react')).toEqual([REACT.toolbar.name]);
  });

  it('names every selector tried to recognise the page when neither view is recognised', () => {
    load('<head></head><body></body>');
    expect(missingFor(document, null)).toEqual([CLASSIC.file.name, REACT.file.name, REACT.toolbar.name]);
  });
});

describe('findFile', () => {
  it('finds the file container by its anchor id in both fixture views', () => {
    load(CLASSIC_HTML);
    expect(findFile(document, PAUSE)?.getAttribute('data-tagsearch-path')).toBe('src/pause.ts');
    expect(findFile(document, GUARD)?.getAttribute('data-tagsearch-path')).toBe('src/guard.ts');
    load(REACT_HTML);
    expect(findFile(document, PAUSE)?.querySelector('h3')?.textContent).toContain('src/pause.ts');
    expect(findFile(document, GUARD)?.querySelector('h3')?.textContent).toContain('src/guard.ts');
  });

  it('returns null for a file that is not on the page', () => {
    load(CLASSIC_HTML);
    expect(findFile(document, `diff-${'0'.repeat(64)}`)).toBeNull();
  });
});

describe('findLine', () => {
  it('finds the row of a new-side line in the classic view and in the react view', () => {
    load(CLASSIC_HTML);
    const classic = findLine(document, 'classic', findFile(document, PAUSE)!, PAUSE, 11);
    expect(classic?.tagName).toBe('TR');
    expect(codeOf(classic)).toBe('code - 11');
    expect(codeOf(findLine(document, 'classic', findFile(document, GUARD)!, GUARD, 4))).toBe('code - 4');
    load(REACT_HTML);
    const react = findLine(document, 'react', findFile(document, PAUSE)!, PAUSE, 11);
    expect(react?.tagName).toBe('TR');
    expect(codeOf(react)).toBe('code - 11');
    expect(codeOf(findLine(document, 'react', findFile(document, PAUSE)!, PAUSE, 13))).toBe('code 12 13');
    expect(codeOf(findLine(document, 'react', findFile(document, GUARD)!, GUARD, 4))).toBe('code - 4');
  });

  it('returns null for a line that is not rendered (line-not-on-page)', () => {
    load(CLASSIC_HTML);
    expect(findLine(document, 'classic', findFile(document, PAUSE)!, PAUSE, 99)).toBeNull();
    load(REACT_HTML);
    expect(findLine(document, 'react', findFile(document, PAUSE)!, PAUSE, 99)).toBeNull();
  });

  it('never matches a deleted row by its old line number', () => {
    load(REACT_HTML);
    // src/guard.ts line 4 is the old side of the context row and the new side of the added row before it.
    const file = findFile(document, GUARD)!;
    expect(codeOf(findLine(document, 'react', file, GUARD, 4))).toBe('code - 4');
    // src/pause.ts has a deleted row with old line 11 before the added row with new line 11.
    expect(codeOf(findLine(document, 'react', findFile(document, PAUSE)!, PAUSE, 11))).toBe('code - 11');
    splitGuard();
    expect(findLine(document, 'react', file, GUARD, 6)).toBeNull();
    load(CLASSIC_HTML);
    expect(codeOf(findLine(document, 'classic', findFile(document, PAUSE)!, PAUSE, 11))).toBe('code - 11');
  });

  it('reads the new side of the newer view in its split layout', () => {
    load(REACT_HTML);
    splitGuard();
    const file = findFile(document, GUARD)!;
    // The new side's code is the row's last code cell.
    const newCode = (row: HTMLElement | null) => [...(row?.querySelectorAll('.diff-text-inner') ?? [])].at(-1)?.textContent;
    expect(newCode(findLine(document, 'react', file, GUARD, 3))).toBe('code 3');
    expect(newCode(findLine(document, 'react', file, GUARD, 4))).toBe('code 4');
    expect(newCode(findLine(document, 'react', file, GUARD, 5))).toBe('code 5');
  });

  it('looks only inside the given file in the newer view', () => {
    load(REACT_HTML);
    // Line 3 is in src/guard.ts only.
    expect(findLine(document, 'react', findFile(document, PAUSE)!, PAUSE, 3)).toBeNull();
  });
});

describe('targetsOf', () => {
  it('marks the cells of a classic row and the row itself in the newer view', () => {
    load(CLASSIC_HTML);
    const classic = findLine(document, 'classic', findFile(document, PAUSE)!, PAUSE, 11)!;
    expect(targetsOf('classic', classic)).toEqual([...classic.querySelectorAll('td')]);
    load(REACT_HTML);
    const react = findLine(document, 'react', findFile(document, PAUSE)!, PAUSE, 11)!;
    expect(targetsOf('react', react)).toEqual([react]);
  });
});
