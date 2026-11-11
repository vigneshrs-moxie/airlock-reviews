import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';

export const FAKE_PORT = 4699;

export interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
}

export interface FakeService {
  requests: RecordedRequest[];
  close(): Promise<void>;
}

/** A stand-in for the Airlock service: answers GET /hello, 404 for everything else, remembers what it was asked. */
export async function startFakeService(port: number = FAKE_PORT): Promise<FakeService> {
  const requests: RecordedRequest[] = [];
  const server: Server = createServer((req, res) => {
    requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers });
    if (req.method === 'GET' && req.url === '/hello') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ airlock: true, version: 'test', paired: false }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return {
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
