import http from 'node:http';
import type { ServiceEvent } from '@airlock/shared';
import type { Timers } from '../src/runs.js';

/** A clock and timers that move only when a test says so. */
export class FakeClock {
  now = Date.parse('2026-11-11T09:00:00.000Z');
  private nextId = 1;
  private tasks: Array<{ id: number; at: number; fn: () => void; every: number | null }> = [];

  readonly date = (): Date => new Date(this.now);

  readonly timers: Timers = {
    setTimeout: (fn, ms) => this.add(fn, ms, null),
    setInterval: (fn, ms) => this.add(fn, ms, ms),
  };

  /** How many timers are waiting. */
  get pending(): number {
    return this.tasks.length;
  }

  private add(fn: () => void, ms: number, every: number | null): () => void {
    const id = this.nextId++;
    this.tasks.push({ id, at: this.now + ms, fn, every });
    return () => { this.tasks = this.tasks.filter((t) => t.id !== id); };
  }

  /** Moves the clock forward, running every timer that falls due on the way, in order. */
  advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      const due = this.tasks.filter((t) => t.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (due === undefined) break;
      this.now = due.at;
      if (due.every === null) this.tasks = this.tasks.filter((t) => t.id !== due.id);
      else due.at += due.every;
      due.fn();
    }
    this.now = end;
  }
}

/** Waits, on the real clock, until `check` is true. */
export async function until(check: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

export interface Reply { status: number; headers: http.IncomingHttpHeaders; text: string; json: unknown }

export function send(
  port: number, method: string, path: string, opts: { headers?: Record<string, string>; body?: string } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: opts.headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: unknown;
        try { json = JSON.parse(text); } catch { json = undefined; }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

/** A run's event stream read with Node's http module: every `data:` line parsed, every comment kept. */
export interface Stream {
  status: number;
  contentType: string | undefined;
  events: ServiceEvent[];
  comments: string[];
  ended: boolean;
  /** Resolves when the server ends the response. */
  end: Promise<void>;
  /** Drops the connection from the client side. */
  close(): void;
}

export function openStream(port: number, path: string, headers: Record<string, string>): Promise<Stream> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, headers, agent: false }, (res) => {
      let buffer = '';
      let markEnded!: () => void;
      const stream: Stream = {
        status: res.statusCode ?? 0,
        contentType: res.headers['content-type'],
        events: [],
        comments: [],
        ended: false,
        end: new Promise<void>((r) => { markEnded = r; }),
        close: () => req.destroy(),
      };
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buffer += chunk;
        let cut = buffer.indexOf('\n\n');
        while (cut !== -1) {
          const block = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          for (const line of block.split('\n')) {
            if (line.startsWith('data: ')) stream.events.push(JSON.parse(line.slice(6)) as ServiceEvent);
            else if (line.startsWith(':')) stream.comments.push(line.slice(1).trim());
          }
          cut = buffer.indexOf('\n\n');
        }
      });
      const finish = (): void => { stream.ended = true; markEnded(); };
      res.on('end', finish);
      res.on('error', finish);
      res.on('close', finish);
      resolve(stream);
    });
    req.on('error', (e) => reject(e));
    req.end();
  });
}
