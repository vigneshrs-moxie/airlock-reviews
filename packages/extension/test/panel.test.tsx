// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Panel } from '../src/panel/Panel';

afterEach(cleanup);

const reply = (body: unknown, status = 200): typeof fetch => async () => new Response(JSON.stringify(body), { status });
const hello = { airlock: true, version: '1.2.3', paired: false };

describe('Panel', () => {
  it('says checking while waiting', () => {
    render(<Panel fetchImpl={() => new Promise<Response>(() => {})} timeoutMs={60_000} />);
    expect(screen.getByText('Airlock service: checking…')).toBeTruthy();
  });

  it('says the service is connected, with its version', async () => {
    render(<Panel fetchImpl={reply(hello)} />);
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

  it('says the reply is unexpected when the body is not JSON', async () => {
    render(<Panel fetchImpl={async () => new Response('<html>nope</html>', { status: 200 })} />);
    expect(await screen.findByText('Airlock service: unexpected reply')).toBeTruthy();
  });

  it('says the reply is unexpected when the status is not ok even with a valid body', async () => {
    render(<Panel fetchImpl={reply(hello, 500)} />);
    expect(await screen.findByText('Airlock service: unexpected reply')).toBeTruthy();
  });

  it('says not running when the request never answers', async () => {
    const hangs: typeof fetch = (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('timed out', 'TimeoutError')));
      });
    render(<Panel fetchImpl={hangs} timeoutMs={30} />);
    expect(await screen.findByText('Airlock service: not running')).toBeTruthy();
  });

  it('shows review-looking text as plain characters', async () => {
    render(<Panel fetchImpl={reply({ ...hello, version: '<img src=x onerror=alert(1)>' })} />);
    const line = await screen.findByText('Airlock service: connected (version <img src=x onerror=alert(1)>)');
    expect(line.querySelector('img')).toBeNull();
  });
});
