import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DismissBodySchema, DismissalSchema, FindingIdSchema, FingerprintSchema, LEARNED_TEXT_MAX, LEARNED_TEXT_MIN,
  PackIdSchema, PrSummarySchema, RepoSchema, ReviewIdSchema, RestoreBodySchema, RunIdSchema, ServiceEventSchema,
  ServiceStatusSchema, SMALL_PR_LINES, StartReviewBodySchema, StartReviewReplySchema, checkLearnedText, isRepo,
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
    repo: 'acme/widgets', number: 1, reviewId: 'r_0123456789', findingId: 'c_01234567', reason: 'wrong' as const,
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
    const base = { fingerprint: '0123456789abcdef', findingId: 'c_01234567', reviewId: 'r_0123456789', reason: 'wrong', text: '', at: '2026-11-11T00:00:00Z' };
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
  it('no source file of the shared package imports from node: or uses a Node-only global', () => {
    const dir = fileURLToPath(new URL('../src/', import.meta.url));
    const files = readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.ts'));
    expect(files).toContain('testing.ts');
    const banned = [/['"]node:/, /\brequire\(/, /\bprocess\./, /\bBuffer\b/];
    for (const file of files) {
      const source = readFileSync(dir + file, 'utf8');
      for (const pattern of banned) expect(source, `${file} ${pattern}`).not.toMatch(pattern);
    }
  });
});

describe('one repository rule', () => {
  it.each(['..', '.', 'a/..', '../a', './x', '.../x', 'a/b.git', 'a/b.GIT', 'a/.git', '-a/b', 'a-/b', 'a/b/c', '', 'a', 'a b/c', `${'a'.repeat(101)}/b`, `a/${'b'.repeat(101)}`, 'a/b\n'])(
    'refuses %j', (value) => {
      expect(isRepo(value)).toBe(false);
      expect(RepoSchema.safeParse(value).success).toBe(false);
    });
  it.each(['Moxie-Pest-Control-Phoenix/moxie-portal', 'user_corp/repo.js', 'a/b', `${'a'.repeat(100)}/${'b'.repeat(100)}`])(
    'accepts %j', (value) => {
      expect(isRepo(value)).toBe(true);
      expect(RepoSchema.safeParse(value).success).toBe(true);
    });
  it('is used by prRefFromUrl', () => {
    expect(prRefFromUrl('https://github.com/a/b.git/pull/1')).toBeNull();
    expect(prRefFromUrl('https://github.com/-a/b/pull/1')).toBeNull();
    expect(prRefFromUrl('https://github.com/a/.../pull/1')).toBeNull();
    expect(prRefFromUrl('https://github.com/user_corp/repo.js/pull/1')?.repo).toBe('user_corp/repo.js');
  });
  it('is used in replies and requests, with a safe positive integer number', () => {
    const run = { runId: 'run_0123456789ab', repo: 'a/..', number: 1 };
    expect(ServiceStatusSchema.safeParse({ version: '1', claude: true, gh: true, packsDir: '/p', running: [run] }).success).toBe(false);
    expect(ServiceStatusSchema.safeParse({ version: '1', claude: true, gh: true, packsDir: '/p', running: [{ ...run, repo: 'a/b', number: 2 ** 60 }] }).success).toBe(false);
    expect(ServiceStatusSchema.safeParse({ version: '1', claude: true, gh: true, packsDir: '/p', running: [{ ...run, repo: 'a/b' }] }).success).toBe(true);
    expect(StartReviewBodySchema.safeParse({ repo: 'a/..', number: 1 }).success).toBe(false);
    expect(StartReviewBodySchema.safeParse({ repo: 'a/b', number: 2 ** 60 }).success).toBe(false);
    expect(RestoreBodySchema.safeParse({ repo: 'a/b', number: 1, fingerprint: '0123456789abcdef' }).success).toBe(true);
    expect(RestoreBodySchema.safeParse({ repo: 'a/b.git', number: 1, fingerprint: '0123456789abcdef' }).success).toBe(false);
  });
});

describe('bounded ids', () => {
  it.each([
    ['ReviewIdSchema', ReviewIdSchema, 'r_0123456789'],
    ['FindingIdSchema', FindingIdSchema, 'c_01234567'],
    ['FingerprintSchema', FingerprintSchema, '0123456789abcdef'],
    ['RunIdSchema', RunIdSchema, 'run_0123456789ab'],
    ['PackIdSchema', PackIdSchema, 'orbit-mine'],
  ])('%s accepts its form and refuses path-like values', (_name, schema, good) => {
    expect(schema.safeParse(good).success).toBe(true);
    expect(schema.safeParse('../x').success).toBe(false);
    expect(schema.safeParse('a/b').success).toBe(false);
    expect(schema.safeParse(`${good}/x`).success).toBe(false);
    expect(schema.safeParse('').success).toBe(false);
  });
  it('limits packIds to 10 distinct entries', () => {
    const ids = (n: number) => Array.from({ length: n }, (_v, i) => `p${i}`);
    const body = (packIds: string[]) => StartReviewBodySchema.safeParse({ repo: 'a/b', number: 1, packIds }).success;
    expect(body(ids(10))).toBe(true);
    expect(body(ids(11))).toBe(false);
    expect(body(['a', 'a'])).toBe(false);
    expect(body(['../x'])).toBe(false);
    expect(body(['-a'])).toBe(false);
  });
  it('uses ids in replies', () => {
    expect(StartReviewReplySchema.safeParse({ runId: 'run_0123456789ab', reused: false }).success).toBe(true);
    expect(StartReviewReplySchema.safeParse({ runId: '../x', reused: false }).success).toBe(false);
    const base = { findingId: 'c_01234567', reviewId: 'r_0123456789', reason: 'wrong', text: '', at: 'x', learned: null };
    expect(DismissalSchema.safeParse({ ...base, fingerprint: '0123456789abcdef' }).success).toBe(true);
    expect(DismissalSchema.safeParse({ ...base, fingerprint: '../x' }).success).toBe(false);
  });
});

describe('checkLearnedText', () => {
  it('exports the limits', () => {
    expect(LEARNED_TEXT_MAX).toBe(500);
    expect(LEARNED_TEXT_MIN).toBe(10);
  });
  it.each([
    ['U+0085', 'this has a \u0085 next line'], ['U+2028', 'this has a \u2028 separator'],
    ['U+2029', 'this has a \u2029 separator'], ['U+202E', 'this has a \u202E override'],
    ['U+2066', 'this has a \u2066 isolate'], ['U+200B', 'this has a \u200B zero width'],
    ['U+FEFF', 'this has a \uFEFF mark'], ['lone surrogate', 'this has a \uD800 surrogate'],
    ['newline', 'this has a \n newline'], ['DEL', 'this has a \u007f del'],
  ])('refuses %s', (_name, text) => {
    expect(checkLearnedText(text, 'wrong')).toEqual(expect.any(String));
    expect(checkLearnedText(text, 'not-now')).toEqual(expect.any(String));
    expect(DismissBodySchema.safeParse({ repo: 'a/b', number: 1, reviewId: 'r_0123456789', findingId: 'c_01234567', reason: 'wrong', text }).success).toBe(false);
  });
  it('refuses spaces only and leading or trailing whitespace', () => {
    expect(checkLearnedText(' '.repeat(10), 'wrong')).not.toBeNull();
    expect(checkLearnedText(' leading space here', 'wrong')).not.toBeNull();
    expect(checkLearnedText('trailing space here ', 'intended')).not.toBeNull();
    expect(checkLearnedText('fine with inner spaces', 'wrong')).toBeNull();
  });
  it('counts code points, not UTF-16 units', () => {
    expect(checkLearnedText('\u{1F600}'.repeat(500), 'wrong')).toBeNull();
    expect(checkLearnedText('\u{1F600}'.repeat(501), 'wrong')).not.toBeNull();
    expect(checkLearnedText('\u{1F600}'.repeat(10), 'wrong')).toBeNull();
    expect(checkLearnedText('\u{1F600}'.repeat(9), 'wrong')).not.toBeNull();
    expect(checkLearnedText('abcdefghij', 'intended')).toBeNull();
    expect(checkLearnedText('abcdefghi', 'intended')).not.toBeNull();
  });
  it('lets not-now be empty but not wrong or intended', () => {
    expect(checkLearnedText('', 'not-now')).toBeNull();
    expect(checkLearnedText('', 'wrong')).not.toBeNull();
    expect(checkLearnedText('', 'intended')).not.toBeNull();
  });
});
