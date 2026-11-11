import type { LatestReply, PrSummary } from '@airlock/shared';
import { createServer, type IncomingHttpHeaders, type ServerResponse, type Server } from 'node:http';
import { E2E_PORT } from './port';

export interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
}

export interface FakeService {
  requests: RecordedRequest[];
  close(): Promise<void>;
}

export interface FakeServiceOptions {
  port?: number;
  /** When set, the service is paired with this token and answers the pull requests below to it. */
  token?: string;
  /** The pull requests it knows, each with its stored review; none is running. */
  pulls?: { pr: PrSummary; latest: LatestReply }[];
}

function reply(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/**
 * A stand-in for the Airlock service that remembers what it was asked. Unpaired (the default) it answers GET /hello and
 * 404 for everything else. Given a token, it says it is paired and, to that token, answers GET /pr and
 * GET /reviews/latest for the pull requests it was given, and 404 for GET /reviews/running.
 */
export async function startFakeService(options: FakeServiceOptions = {}): Promise<FakeService> {
  const { port = E2E_PORT, token, pulls = [] } = options;
  const requests: RecordedRequest[] = [];
  const server: Server = createServer((req, res) => {
    requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers });
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/hello') {
      reply(res, 200, { airlock: true, version: 'test', paired: token !== undefined });
      return;
    }
    if (token === undefined || req.method !== 'GET') {
      reply(res, 404, {});
      return;
    }
    if (req.headers.authorization !== `Bearer ${token}`) {
      reply(res, 401, { error: 'This panel is not paired.' });
      return;
    }
    const pull = pulls.find((p) => p.pr.repo === url.searchParams.get('repo') && String(p.pr.number) === url.searchParams.get('number'));
    if (url.pathname === '/pr' && pull) reply(res, 200, pull.pr);
    else if (url.pathname === '/reviews/latest' && pull) reply(res, 200, pull.latest);
    else reply(res, 404, { error: 'Not found.' });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', (err: NodeJS.ErrnoException) => {
      reject(
        err.code === 'EADDRINUSE'
          ? new Error(`Port ${port} is already in use: another end-to-end run is going, or a stale process was left behind.`)
          : err,
      );
    });
    server.listen(port, '127.0.0.1', resolve);
  });
  return {
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
