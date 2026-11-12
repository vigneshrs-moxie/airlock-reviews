import { describe, expect, it } from 'vitest';
import type { LearnedLine, RemoveLearnedBody } from '@airlock/shared';
import { NOT_UNDERSTOOD, ServiceClient, ServiceError } from '../../src/client/service';
import { BASE, FakeService, TOKEN, json } from '../helpers/fake-service';
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
    expect(svc.requests[0]?.url.pathname).toBe('/learned');
    expect(svc.requests[0]?.url.searchParams.get('repo')).toBe('acme/widgets');
    expect(svc.requests[0]?.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    svc.on('GET /learned', () => json({ lines: [{ ...line, kind: 'other' }], cap: 300 }));
    expect(await failure(client.learned('acme/widgets'))).toMatchObject({ kind: 'problem', message: NOT_UNDERSTOOD });
  });

  it('removeLearned sends the body to /learned/remove and returns the checked reply', async () => {
    const { svc, client } = setup();
    svc.on('POST /learned/remove', () => json({ removed: false, note: 'That line was already gone.' }));
    expect(await client.removeLearned(body)).toEqual({ removed: false, note: 'That line was already gone.' });
    expect(svc.requests[0]?.body).toEqual(body);
    svc.on('POST /learned/remove', () => json({ error: 'The team kit is not edited here.' }, 403));
    expect(await failure(client.removeLearned(body))).toMatchObject({ kind: 'problem', message: 'The team kit is not edited here.' });
    svc.on('POST /learned/remove', () => json({ removed: 'yes' }));
    expect(await failure(client.removeLearned(body))).toMatchObject({ kind: 'problem', message: NOT_UNDERSTOOD });
  });
});
