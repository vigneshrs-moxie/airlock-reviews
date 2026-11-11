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
    expect(filesUrl('acme/widgets', 7, 'diff-abc')).toBe('https://github.com/acme/widgets/pull/7/files#diff-abc');
    expect(filesUrl('acme/widgets', 7, 'diff-abc', 42)).toBe('https://github.com/acme/widgets/pull/7/files#diff-abcR42');
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
