import { describe, expect, it } from 'vitest';
import type { LearnedLine, RemoveLearnedBody } from '@airlock/shared';
import { NOT_PROVED } from '../../src/client/proof';
import { NOT_UNDERSTOOD, ServiceClient, ServiceError } from '../../src/client/service';
import { BASE, FakeService, OTHER_TOKEN, TOKEN, json } from '../helpers/fake-service';
import { FakeTimers } from '../helpers/fake-timers';

function setup() {
  const svc = new FakeService();
  const client = new ServiceClient(BASE, async () => TOKEN, svc.fetch, new FakeTimers());
  return { svc, client };
}

async function failure(work: Promise<unknown>): Promise<ServiceError> {
  try {
    await work;
  } catch (e) {
    if (e instanceof ServiceError) return e;
    throw e;
  }
  throw new Error('expected a ServiceError');
}

const line: LearnedLine = {
  pack: 'generic', packTitle: 'Generic', kind: 'wrong', date: '2026-11-10', repo: 'acme/widgets',
  text: 'Rounding is intended.', key: '0000000000000001', appliesHere: true, removable: true,
};
const body: RemoveLearnedBody = { repo: 'acme/widgets', pack: 'generic', kind: 'wrong', key: '0000000000000001' };

describe('learned lines through the client', () => {
  it('learned reads GET /learned for the repository and checks the reply', async () => {
    const { svc, client } = setup();
    svc.on('GET /learned', () => json({ lines: [line], cap: 300 }));
    expect(await client.learned('acme/widgets')).toEqual({ lines: [line], cap: 300 });
    // The token goes only after the service proved it holds it.
    expect(svc.calls).toEqual(['GET /hello', 'GET /learned']);
    const [hello, req] = svc.requests;
    expect(hello?.headers.has('authorization')).toBe(false);
    expect(req?.url.searchParams.get('repo')).toBe('acme/widgets');
    expect(req?.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    svc.on('GET /learned', () => json({ lines: [{ ...line, kind: 'other' }], cap: 300 }));
    expect(await failure(client.learned('acme/widgets'))).toMatchObject({ kind: 'problem', message: NOT_UNDERSTOOD });
  });

  it('removeLearned sends the body to /learned/remove and returns the checked reply', async () => {
    const { svc, client } = setup();
    svc.on('POST /learned/remove', () => json({ removed: false, note: 'That line was already gone.' }));
    expect(await client.removeLearned(body)).toEqual({ removed: false, note: 'That line was already gone.' });
    expect(svc.calls).toEqual(['GET /hello', 'POST /learned/remove']);
    expect(svc.requests[1]?.body).toEqual(body);
    expect(svc.requests[1]?.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    svc.on('POST /learned/remove', () => json({ error: 'The team kit is not edited here.' }, 403));
    expect(await failure(client.removeLearned(body))).toMatchObject({ kind: 'problem', message: 'The team kit is not edited here.' });
    svc.on('POST /learned/remove', () => json({ removed: 'yes' }));
    expect(await failure(client.removeLearned(body))).toMatchObject({ kind: 'problem', message: NOT_UNDERSTOOD });
  });

  it('learned and removeLearned send nothing with the token to something that cannot prove it holds it', async () => {
    for (const key of [OTHER_TOKEN, null]) {
      const { svc, client } = setup();
      svc.proofKey = key;
      expect(await failure(client.learned('acme/widgets'))).toMatchObject({ kind: 'unproven', message: NOT_PROVED });
      expect(await failure(client.removeLearned(body))).toMatchObject({ kind: 'unproven', message: NOT_PROVED });
      expect(svc.requests.filter((r) => r.headers.has('authorization'))).toEqual([]);
      expect(new Set(svc.calls)).toEqual(new Set(['GET /hello']));
    }
  });
});
