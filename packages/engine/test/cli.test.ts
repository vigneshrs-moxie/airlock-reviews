import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { minimalDocument, type ReviewDocument } from '@airlock/shared';
import type { ReviewEvent } from '@airlock/shared';
import { usage } from '../src/cli-args.js';
import { createSdkRunner } from '../src/agent/sdk-runner.js';
import { main, type CliIo, type CliOverrides } from '../src/cli.js';
import { renderReview } from '../src/render/terminal.js';
import type { EngineDeps, ReviewRequest } from '../src/pipeline/review.js';

vi.mock('../src/agent/sdk-runner.js', () => ({ createSdkRunner: vi.fn(() => { throw new Error('the real runner was built'); }) }));

type Review = NonNullable<CliOverrides['review']>;

const packsDir = mkdtempSync(join(tmpdir(), 'airlock-cli-packs-'));
const fakeDeps = { exec: vi.fn(), runner: { run: vi.fn() }, now: () => new Date(0) } as unknown as EngineDeps;

function harness(doc: ReviewDocument = minimalDocument(), events: ReviewEvent[] = []) {
  const out: string[] = [];
  const err: string[] = [];
  const requests: ReviewRequest[] = [];
  const io: CliIo = { out: (t) => out.push(t), err: (t) => err.push(t), color: false };
  const review: Review = async (req, _deps, onEvent) => {
    requests.push(req);
    for (const e of events) onEvent?.(e);
    return doc;
  };
  const overrides: CliOverrides = { review, deps: fakeDeps, packsDir };
  return { out, err, requests, io, overrides };
}

beforeEach(() => { vi.mocked(createSdkRunner).mockClear(); });

describe('main', () => {
  it('prints usage and returns 0 for help and for no arguments', async () => {
    for (const argv of [['help'], []]) {
      const h = harness();
      expect(await main(argv, h.io, h.overrides)).toBe(0);
      expect(h.out.join('')).toContain(usage());
      expect(h.requests).toHaveLength(0);
    }
  });

  it('returns 2 and prints the message for a bad argument and for a bad pull request reference', async () => {
    for (const argv of [['review', 'a/b#1', '--bogus'], ['review', 'not-a-ref']]) {
      const h = harness();
      expect(await main(argv, h.io, h.overrides)).toBe(2);
      expect(h.err.join('')).not.toBe('');
      expect(h.out).toEqual([]);
      expect(h.requests).toHaveLength(0);
    }
  });

  it('passes repo, number, depth, packs, model and explicit SHAs to the review', async () => {
    const h = harness();
    const argv = ['review', 'acme/widgets#42', '--depth', 'deep', '--packs', 'core,extra', '--model', 'm1', '--base', 'abcdef1', '--head', '1234567'];
    expect(await main(argv, h.io, h.overrides)).toBe(0);
    expect(h.requests[0]).toMatchObject({
      repo: 'acme/widgets', number: 42, depth: 'deep', packIds: ['core', 'extra'], packsDir,
      explicit: { baseSha: 'abcdef1', headSha: '1234567' },
    });
  });

  it('leaves packIds and explicit out when they are not given', async () => {
    const h = harness();
    await main(['review', 'acme/widgets#42'], h.io, h.overrides);
    expect(h.requests[0]).not.toHaveProperty('packIds');
    expect(h.requests[0]).not.toHaveProperty('explicit');
    expect(h.requests[0]).not.toHaveProperty('models');
  });

  it('sets main, challenger and sweep from --model', async () => {
    const h = harness();
    await main(['review', 'acme/widgets#42', '--model', 'claude-x'], h.io, h.overrides);
    expect(h.requests[0]!.models).toEqual({ main: 'claude-x', challenger: 'claude-x', sweep: 'claude-x' });
  });

  it('prints the rendered review to out and progress lines to err', async () => {
    const doc = minimalDocument();
    const events: ReviewEvent[] = [
      { type: 'stage', stage: 'intake', status: 'start', detail: '' },
      { type: 'stage', stage: 'intake', status: 'done', detail: '' },
      { type: 'stage', stage: 'lenses', status: 'error', detail: 'it broke' },
      { type: 'map', map: { cohorts: [{ id: 'k', title: 't', summary: '', neighbours: [], inferredLinks: [], layers: [] }, { id: 'k2', title: 't', summary: '', neighbours: [], inferredLinks: [], layers: [] }], standalone: [], links: [] } },
      { type: 'brief', brief: { whatItDoes: [], claims: [] } },
      { type: 'done', document: doc },
    ];
    const h = harness(doc, events);
    await main(['review', 'acme/widgets#42'], h.io, h.overrides);
    expect(h.out.join('')).toBe(renderReview(doc, { color: false }));
    expect(h.err.join('').split('\n').filter((l) => l !== '')).toEqual([
      'intake: start', 'intake: done', 'lenses: error: it broke', 'map: 2 groups', 'brief: ready',
    ]);
  });

  it('writes the document to the --json file after printing', async () => {
    const doc = minimalDocument();
    const h = harness(doc);
    const order: string[] = [];
    h.io.out = () => order.push('print');
    const writeFile = async (path: string, text: string) => { order.push(`write ${path}`); writeFileSync(path, text); };
    const file = join(mkdtempSync(join(tmpdir(), 'airlock-cli-json-')), 'doc.json');
    expect(await main(['review', 'acme/widgets#42', '--json', file], h.io, { ...h.overrides, writeFile })).toBe(0);
    expect(order).toEqual(['print', `write ${file}`]);
    expect(readFileSync(file, 'utf8')).toBe(JSON.stringify(doc, null, 2) + '\n');
  });

  it('writes the --json file with the default writer', async () => {
    const doc = minimalDocument();
    const h = harness(doc);
    const file = join(mkdtempSync(join(tmpdir(), 'airlock-cli-json-')), 'doc.json');
    expect(await main(['review', 'acme/widgets#42', '--json', file], h.io, h.overrides)).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe(JSON.stringify(doc, null, 2) + '\n');
  });

  it('returns 1 and says the review was printed when the --json file cannot be written', async () => {
    const h = harness();
    const writeFile = async () => { throw new Error('disk full'); };
    expect(await main(['review', 'acme/widgets#42', '--json', 'out.json'], h.io, { ...h.overrides, writeFile })).toBe(1);
    expect(h.out.join('')).not.toBe('');
    expect(h.err.join('')).toContain('The review was printed, but the file out.json could not be written: disk full');
  });

  it('returns 1 with a plain message and no stack when the review throws', async () => {
    const h = harness();
    h.overrides.review = async () => { throw new Error('gh is not signed in'); };
    expect(await main(['review', 'acme/widgets#42'], h.io, h.overrides)).toBe(1);
    const err = h.err.join('');
    expect(err).toContain('Airlock could not review this pull request: gh is not signed in');
    expect(err).not.toMatch(/\n\s+at /);
    expect(h.out).toEqual([]);
  });

  it('returns 0 for an incomplete review', async () => {
    const doc = minimalDocument();
    doc.verdict = { ...doc.verdict, label: 'incomplete' };
    const h = harness(doc);
    expect(await main(['review', 'acme/widgets#42'], h.io, h.overrides)).toBe(0);
  });

  it('returns 1 when the packs folder does not exist', async () => {
    const h = harness();
    const missing = join(packsDir, 'nope');
    expect(await main(['review', 'acme/widgets#42'], h.io, { ...h.overrides, packsDir: missing })).toBe(1);
    expect(h.err.join('')).toContain(`The packs folder was not found at ${missing}. Set AIRLOCK_PACKS_DIR to its location.`);
    expect(h.requests).toHaveLength(0);
  });

  it('cleans control characters out of progress messages', async () => {
    const h = harness(minimalDocument(), [{ type: 'stage', stage: 'x\u001b[31m', status: 'error', detail: 'bad\r\nforged: done\u0007' }]);
    await main(['review', 'acme/widgets#42'], h.io, h.overrides);
    const err = h.err.join('');
    expect(err).toContain('x[31m: error: bad forged: done');
    for (const c of ['\u001b', '\u0007', '\r']) expect(err).not.toContain(c);
    expect(err.split('\n').filter((l) => l !== '')).toHaveLength(1);
  });

  it('does not build the real runner when a fake review is given', async () => {
    const h = harness();
    delete h.overrides.deps;
    expect(await main(['review', 'acme/widgets#42'], h.io, h.overrides)).toBe(0);
    expect(createSdkRunner).not.toHaveBeenCalled();
  });
});
