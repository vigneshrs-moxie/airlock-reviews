import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { blobUrl, diffAnchorId, filesUrl } from '@airlock/shared';

describe('diff anchors and links', () => {
  it('diffAnchorId of "extension/content.css" is diff- plus its SHA-256', async () => {
    const path = 'extension/content.css';
    const expected = `diff-${createHash('sha256').update(path).digest('hex')}`;
    expect(await diffAnchorId(path)).toBe(expected);
  });
  it('hashes the UTF-8 bytes of a non-ASCII path', async () => {
    const path = 'docs/café ☃.md';
    expect(await diffAnchorId(path)).toBe(`diff-${createHash('sha256').update(path, 'utf8').digest('hex')}`);
  });
  it('filesUrl adds the anchor and then the line', () => {
    expect(filesUrl('acme/widgets', 7)).toBe('https://github.com/acme/widgets/pull/7/files');
    const id = `diff-${'0'.repeat(64)}`;
    expect(filesUrl('acme/widgets', 7, id)).toBe(`https://github.com/acme/widgets/pull/7/files#${id}`);
    expect(filesUrl('acme/widgets', 7, id, 42)).toBe(`https://github.com/acme/widgets/pull/7/files#${id}R42`);
    expect(filesUrl('acme/widgets', 7, undefined, 42)).toBe('https://github.com/acme/widgets/pull/7/files');
  });
  it('blobUrl percent-encodes each path segment and keeps the slashes', () => {
    const sha = 'c'.repeat(40);
    expect(blobUrl('acme/widgets', sha, 'src/my file/a#b?.ts')).toBe(
      `https://github.com/acme/widgets/blob/${sha}/src/my%20file/a%23b%3F.ts`,
    );
    expect(blobUrl('acme/widgets', sha, 'a.ts', 9)).toBe(`https://github.com/acme/widgets/blob/${sha}/a.ts#L9`);
    expect(blobUrl('acme/widgets', sha, 'a.ts', null)).toBe(`https://github.com/acme/widgets/blob/${sha}/a.ts`);
  });
});

describe('URL builders cannot throw or be steered', () => {
  const sha = 'c'.repeat(40);
  const anchor = `diff-${'a'.repeat(64)}`;
  it('diffAnchorId hashes the well-formed form of a lone surrogate', async () => {
    const fixed = 'a\uFFFDb';
    expect(await diffAnchorId('a\uD800b')).toBe(`diff-${createHash('sha256').update(fixed, 'utf8').digest('hex')}`);
  });
  it('filesUrl returns null for a bad repo, number or anchor', () => {
    expect(filesUrl('a/..', 1)).toBeNull();
    expect(filesUrl('a/b.git', 1)).toBeNull();
    expect(filesUrl('a/b', 0)).toBeNull();
    expect(filesUrl('a/b', 1.5)).toBeNull();
    expect(filesUrl('a/b', 2 ** 60)).toBeNull();
    expect(filesUrl('a/b', 1, 'diff-abc')).toBeNull();
    expect(filesUrl('a/b', 1, `${anchor}?x`)).toBeNull();
    expect(filesUrl('a/b', 1, anchor, 3)).toBe(`https://github.com/a/b/pull/1/files#${anchor}R3`);
  });
  it.each([-3, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 0, 2 ** 60])('filesUrl ignores line %s', (line) => {
    expect(filesUrl('a/b', 1, anchor, line)).toBe(`https://github.com/a/b/pull/1/files#${anchor}`);
  });
  it('blobUrl returns null for a bad repo, sha or path', () => {
    expect(blobUrl('a/..', sha, 'x.ts')).toBeNull();
    expect(blobUrl('a/b', 'abc12', 'x.ts')).toBeNull();
    for (const bad of [`${sha}/x`, `${sha}?x`, `${sha}#x`, 'g'.repeat(40), 'a'.repeat(65)]) {
      expect(blobUrl('a/b', bad, 'x.ts')).toBeNull();
    }
    for (const path of ['', '/a', 'a\\b', 'a\u0000b', 'a/../b', 'a//b', 'a/./b', '..', '.', 'a/', 'a\uD800b']) {
      expect(blobUrl('a/b', sha, path), JSON.stringify(path)).toBeNull();
    }
    expect(blobUrl('a/b', 'abcdef1', 'x..ts')).toBe('https://github.com/a/b/blob/abcdef1/x..ts');
  });
  it.each([-3, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 0])('blobUrl ignores line %s', (line) => {
    expect(blobUrl('a/b', sha, 'x.ts', line)).toBe(`https://github.com/a/b/blob/${sha}/x.ts`);
  });
});
