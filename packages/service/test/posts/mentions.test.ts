import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { saveReview } from '@airlock/engine';
import { commentBody } from '@airlock/shared';
import { buildPreview, Previews } from '../../src/posts/preview.js';
import { FINDING_A, FINDING_B, FINDING_C, FP_A, FP_B, FP_C, NUMBER, REPO, REVIEW, review } from './rig.js';

// The preview is tested against the shared mentionsIn itself: it reports every `@name` wherever it stands, code or
// not, because it is for text the person typed.

const savedHome = process.env['AIRLOCK_HOME'];
let home: string | null = null;
afterEach(async () => {
  if (home !== null) await rm(home, { recursive: true, force: true });
  home = null;
  if (savedHome === undefined) delete process.env['AIRLOCK_HOME'];
  else process.env['AIRLOCK_HOME'] = savedHome;
});

// The summary-only finding's suggested change holds a name inside a code block, which drafted text leaves as it is.
const FENCED_B = { ...FINDING_B, suggestedChange: '```\nnotify("@bob")\n```' };

async function preview(
  items: Array<{ fingerprint: string; body?: string; placement?: 'inline' | 'summary' }>, summary?: string,
) {
  if (home !== null) await rm(home, { recursive: true, force: true });
  home = await mkdtemp(join(tmpdir(), 'airlock-service-mentions-'));
  process.env['AIRLOCK_HOME'] = home;
  await saveReview({ ...review(), findings: [FINDING_A, FENCED_B, FINDING_C] });
  const deps = { home, now: () => new Date('2026-11-11T09:00:00.000Z'), previews: new Previews(), dismissals: async () => [] };
  return buildPreview(deps, { repo: REPO, number: NUMBER, reviewId: REVIEW, items, ...(summary === undefined ? {} : { summary }) });
}

describe('mentions in a preview', () => {
  it('are empty for a body that is exactly the one drafted from the finding, and what mentionsIn finds otherwise', async () => {
    const drafted = commentBody(FINDING_A);
    // The drafted text breaks the name with a space and holds no backtick in its prose, so GitHub notifies no one.
    expect(drafted).toContain('It adds @ carol to the list.');
    expect(drafted).not.toContain('@carol');
    expect(drafted).not.toContain('`');
    const p = await preview([{ fingerprint: FP_A }, { fingerprint: FP_C, body: 'Please look, @dave and `@erin`.' }]);
    expect(p.items[0]?.mentions).toEqual([]);
    expect(p.items[1]?.mentions).toEqual(['@dave', '@erin']);

    // The drafted text sent back unchanged is still the drafted text; once changed, it is the person's: the space taken
    // out of the name makes it live, and it is listed.
    const same = await preview([{ fingerprint: FP_A, body: drafted }]);
    expect(same.items[0]?.mentions).toEqual([]);
    const changed = await preview([{ fingerprint: FP_A, body: drafted.replace('@ carol', '@carol') }]);
    expect(changed.items[0]?.mentions).toEqual(['@carol']);
    // Changed by one character elsewhere, it is still checked, and the broken name is not one.
    const touched = await preview([{ fingerprint: FP_A, body: `${drafted}!` }]);
    expect(touched.items[0]?.mentions).toEqual([]);
  });

  it('all default text gives empty lists, the review body included', async () => {
    const p = await preview([{ fingerprint: FP_A }, { fingerprint: FP_B }, { fingerprint: FP_C }]);
    expect(p.reviewBody).toContain('@bob');
    expect(p.items.map((i) => i.mentions)).toEqual([[], [], []]);
    expect(p.reviewBodyMentions).toEqual([]);
    // The generated summary sent back word for word is still the service's own text.
    const same = await preview([{ fingerprint: FP_A }, { fingerprint: FP_B }], 'Review notes from Airlock: 2 comments.');
    expect(same.reviewBodyMentions).toEqual([]);
  });

  it('an edited summary lists every name in the review body, those in default code parts included', async () => {
    const p = await preview([{ fingerprint: FP_A }, { fingerprint: FP_B }], 'Thanks @frank.');
    expect(p.reviewBody).toContain('Thanks @frank.');
    expect(p.reviewBodyMentions).toEqual(['@frank', '@bob']);
    expect(p.items.map((i) => i.mentions)).toEqual([[], []]);
  });

  it('an edited inline comment lists only its own names; an edited one in the summary also fills the review body list', async () => {
    const inline = await preview([{ fingerprint: FP_A, body: 'Ask @gina.' }, { fingerprint: FP_B }]);
    expect(inline.items.map((i) => i.mentions)).toEqual([['@gina'], []]);
    expect(inline.reviewBodyMentions).toEqual([]);
    const inSummary = await preview([{ fingerprint: FP_A, body: 'Ask @gina.', placement: 'summary' }, { fingerprint: FP_B }]);
    expect(inSummary.items.map((i) => i.mentions)).toEqual([['@gina'], []]);
    expect(inSummary.reviewBodyMentions).toEqual(['@gina', '@bob']);
  });
});
