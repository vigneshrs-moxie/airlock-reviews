import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DismissBodySchema, DismissalSchema, PrSummarySchema, ServiceEventSchema, SMALL_PR_LINES, StartReviewBodySchema,
  minimalDocument, prRefFromUrl, suggestedDepth,
} from '@airlock/shared';

describe('suggestedDepth', () => {
  it('suggests quick at 150 changed lines and standard at 151', () => {
    expect(SMALL_PR_LINES).toBe(150);
    expect(suggestedDepth(100, 50)).toBe('quick');
    expect(suggestedDepth(100, 51)).toBe('standard');
    expect(suggestedDepth(0, 0)).toBe('quick');
  });
});

describe('prRefFromUrl', () => {
  const base = 'https://github.com/acme/widgets/pull/12';
  it('reads repo, number and page from files, changes, commits and conversation URLs, and returns null elsewhere', () => {
    const ref = (page: string) => ({ repo: 'acme/widgets', number: 12, page });
    expect(prRefFromUrl(base)).toEqual(ref('conversation'));
    expect(prRefFromUrl(`${base}/`)).toEqual(ref('conversation'));
    expect(prRefFromUrl(`${base}/files`)).toEqual(ref('files'));
    expect(prRefFromUrl(`${base}/changes`)).toEqual(ref('files'));
    expect(prRefFromUrl(`${base}/changes/abc123`)).toEqual(ref('files'));
    expect(prRefFromUrl(`${base}/commits`)).toEqual(ref('commits'));
    expect(prRefFromUrl(`${base}/commits/abc123`)).toEqual(ref('commits'));
    expect(prRefFromUrl(`${base}/checks`)).toEqual(ref('checks'));
    expect(prRefFromUrl(`${base}/whatever`)).toEqual(ref('other'));
    expect(prRefFromUrl(`${base}/files?w=1#diff-abc`)).toEqual(ref('files'));
    expect(prRefFromUrl(`${base}?x=1#issuecomment-5`)).toEqual(ref('conversation'));
    expect(prRefFromUrl('http://github.com/acme/widgets/pull/12')).toBeNull();
    expect(prRefFromUrl('https://gitlab.com/acme/widgets/pull/12')).toBeNull();
    expect(prRefFromUrl('https://github.com/acme/widgets/pull/0')).toBeNull();
    expect(prRefFromUrl('https://github.com/acme/widgets/pull/abc')).toBeNull();
    expect(prRefFromUrl('https://github.com/acme/widgets/issues/12')).toBeNull();
    expect(prRefFromUrl('https://github.com/acme/widgets')).toBeNull();
    expect(prRefFromUrl('not a url')).toBeNull();
    expect(prRefFromUrl('')).toBeNull();
  });
  it('rejects a repo with a slash too many, a path traversal or a space', () => {
    expect(prRefFromUrl('https://github.com/acme/widgets/extra/pull/12')).toBeNull();
    expect(prRefFromUrl('https://github.com/acme/wid%20gets/pull/12')).toBeNull();
    expect(prRefFromUrl('https://github.com/acme/wid gets/pull/12')).toBeNull();
    expect(prRefFromUrl('https://github.com/acme%2F..%2Fx/widgets/pull/12')).toBeNull();
  });
});

describe('request and reply schemas', () => {
  const dismissal = {
    repo: 'acme/widgets', number: 1, reviewId: 'review-1', findingId: 'f1', reason: 'wrong' as const,
    text: 'This is checked in the caller.',
  };
  it('a dismissal of kind wrong needs at least 10 characters and one line', () => {
    expect(DismissBodySchema.safeParse(dismissal).success).toBe(true);
    expect(DismissBodySchema.safeParse({ ...dismissal, text: 'too short' }).success).toBe(false);
    expect(DismissBodySchema.safeParse({ ...dismissal, reason: 'intended', text: 'short' }).success).toBe(false);
    expect(DismissBodySchema.safeParse({ ...dismissal, text: 'first line here\nsecond line' }).success).toBe(false);
    expect(DismissBodySchema.safeParse({ ...dismissal, text: 'a'.repeat(501) }).success).toBe(false);
    expect(DismissBodySchema.safeParse({ ...dismissal, text: 'has a \u0007 bell in it' }).success).toBe(false);
    expect(DismissBodySchema.safeParse({ ...dismissal, reason: 'not-now', text: '' }).success).toBe(true);
    expect(DismissBodySchema.safeParse({ ...dismissal, reason: 'not-now', text: 'a\nb' }).success).toBe(false);
    expect(DismissBodySchema.safeParse({ ...dismissal, repo: 'acme/widgets/x' }).success).toBe(false);
    expect(DismissBodySchema.safeParse({ ...dismissal, number: 0 }).success).toBe(false);
  });
  it('validates repo and number on a start request and ignores unknown keys', () => {
    expect(StartReviewBodySchema.safeParse({ repo: 'acme/widgets', number: 3, extra: 1 }).success).toBe(true);
    expect(StartReviewBodySchema.safeParse({ repo: 'acme widgets', number: 3 }).success).toBe(false);
    expect(StartReviewBodySchema.safeParse({ repo: 'acme/widgets', number: 1.5 }).success).toBe(false);
    expect(StartReviewBodySchema.safeParse({ repo: 'acme/widgets', number: 3, depth: 'deep', packIds: ['a'] }).success).toBe(true);
  });
  it('accepts a dismissal with and without a learned line', () => {
    const base = { fingerprint: 'fp', findingId: 'f1', reviewId: 'r1', reason: 'wrong', text: '', at: '2026-11-11T00:00:00Z' };
    expect(DismissalSchema.safeParse({ ...base, learned: null }).success).toBe(true);
    expect(DismissalSchema.safeParse({ ...base, learned: { packId: 'core', kind: 'wrong', date: '2026-11-11' } }).success).toBe(true);
    expect(DismissalSchema.safeParse({ ...base, learned: { packId: 'core', kind: 'not-now', date: 'x' } }).success).toBe(false);
  });
  it('requires every field of a pull request summary', () => {
    const summary = {
      repo: 'acme/widgets', number: 1, title: 't', author: 'a', viewer: 'v', isOwn: false, stage: 'pr1',
      baseRef: 'main', headRef: 'x', headSha: 'abc', additions: 1, deletions: 2, changedFiles: 1,
      packs: [{ id: 'core', title: 'Core' }], suggestedDepth: 'quick',
    };
    expect(PrSummarySchema.safeParse(summary).success).toBe(true);
    const { headSha: _omit, ...rest } = summary;
    expect(PrSummarySchema.safeParse(rest).success).toBe(false);
  });
  it('ServiceEvent accepts every ReviewEvent and the failed event', () => {
    const doc = minimalDocument();
    const events = [
      { type: 'stage', stage: 'map', status: 'start', detail: '' },
      { type: 'brief', brief: doc.brief },
      { type: 'map', map: doc.map },
      { type: 'done', document: doc },
      { type: 'failed', message: 'claude is not signed in' },
    ];
    for (const event of events) expect(ServiceEventSchema.safeParse(event).success).toBe(true);
    expect(ServiceEventSchema.safeParse({ type: 'failed' }).success).toBe(false);
    expect(ServiceEventSchema.safeParse({ type: 'other' }).success).toBe(false);
  });
});

describe('portability', () => {
  it('no source file of the shared package imports from node:', () => {
    const dir = fileURLToPath(new URL('../src/', import.meta.url));
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = readFileSync(dir + file, 'utf8');
      expect(source, file).not.toContain("from 'node:");
      expect(source, file).not.toContain('require(');
    }
  });
});
