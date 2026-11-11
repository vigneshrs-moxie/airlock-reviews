// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Panel } from '../src/panel/Panel';

afterEach(cleanup);

const reply = (body: unknown): typeof fetch => async () => new Response(JSON.stringify(body), { status: 200 });

describe('Panel', () => {
  it('says the service is connected, with its version', async () => {
    render(<Panel fetchImpl={reply({ airlock: true, version: '1.2.3', paired: false })} />);
    expect(await screen.findByText('Airlock service: connected (version 1.2.3)')).toBeTruthy();
  });

  it('says the service is not running when the request fails', async () => {
    render(<Panel fetchImpl={async () => { throw new TypeError('Failed to fetch'); }} />);
    expect(await screen.findByText('Airlock service: not running')).toBeTruthy();
  });

  it('says the reply is unexpected when it is not a hello', async () => {
    render(<Panel fetchImpl={reply({ hello: 'world' })} />);
    expect(await screen.findByText('Airlock service: unexpected reply')).toBeTruthy();
  });

  it('shows review-looking text as plain characters', async () => {
    render(<Panel fetchImpl={reply({ airlock: true, version: '<img src=x onerror=alert(1)>', paired: false })} />);
    const line = await screen.findByText('Airlock service: connected (version <img src=x onerror=alert(1)>)');
    expect(line.querySelector('img')).toBeNull();
  });
});
