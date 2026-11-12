import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { saveReview } from '@airlock/engine';
import { commentBody } from '@airlock/shared';
import { buildPreview, Previews } from '../../src/posts/preview.js';
import { FINDING_A, FP_A, FP_B, NUMBER, REPO, REVIEW, review } from './rig.js';

// The shared mentionsIn is changing to report every `@name` wherever it stands, code or not, because it is for text the
// person typed. This stand-in behaves that way, so the preview is tested against it.
vi.mock('@airlock/shared', async (original) => ({
  ...(await original<typeof import('@airlock/shared')>()),
  mentionsIn: (text: string): string[] => [...new Set(text.match(/@[A-Za-z0-9][A-Za-z0-9-]*/g) ?? [])],
}));

const savedHome = process.env['AIRLOCK_HOME'];
let home: string | null = null;
afterEach(async () => {
  if (home !== null) await rm(home, { recursive: true, force: true });
  home = null;
  if (savedHome === undefined) delete process.env['AIRLOCK_HOME'];
  else process.env['AIRLOCK_HOME'] = savedHome;
});

async function preview(items: Array<{ fingerprint: string; body?: string }>) {
  home = await mkdtemp(join(tmpdir(), 'airlock-service-mentions-'));
  process.env['AIRLOCK_HOME'] = home;
  await saveReview(review());
  const deps = { home, now: () => new Date('2026-11-11T09:00:00.000Z'), previews: new Previews(), dismissals: async () => [] };
  return buildPreview(deps, { repo: REPO, number: NUMBER, reviewId: REVIEW, items });
}

describe('mentions in a preview', () => {
  it('are empty for a body that is exactly the one drafted from the finding, and what mentionsIn finds otherwise', async () => {
    const drafted = commentBody(FINDING_A);
    // The drafted text names someone, in backticks, so GitHub notifies no one.
    expect(drafted).toContain('`@carol`');
    const p = await preview([{ fingerprint: FP_A }, { fingerprint: FP_B, body: 'Please look, @dave and `@erin`.' }]);
    expect(p.items[0]?.mentions).toEqual([]);
    expect(p.items[1]?.mentions).toEqual(['@dave', '@erin']);

    // The drafted text sent back unchanged is still the drafted text; changed by one character, it is the person's.
    const same = await preview([{ fingerprint: FP_A, body: drafted }]);
    expect(same.items[0]?.mentions).toEqual([]);
    const changed = await preview([{ fingerprint: FP_A, body: `${drafted}!` }]);
    expect(changed.items[0]?.mentions).toEqual(['@carol']);
  });
});
