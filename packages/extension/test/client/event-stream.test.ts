import { describe, expect, it } from 'vitest';
import { EventDataError, readEventStream } from '../../src/client/event-stream';

/** A stream that hands over exactly these byte chunks, in order. */
function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

/** Splits the UTF-8 bytes of the text at the given byte offsets. */
function split(text: string, at: number[]): Uint8Array[] {
  const bytes = new TextEncoder().encode(text);
  const cuts = [0, ...at, bytes.length];
  return cuts.slice(1).map((end, i) => bytes.slice(cuts[i], end));
}

async function collect(chunks: Uint8Array[]): Promise<unknown[]> {
  const seen: unknown[] = [];
  await readEventStream(streamOf(chunks), (data) => seen.push(data));
  return seen;
}

describe('readEventStream', () => {
  it('reads events split across chunk boundaries and ignores keep-alive comments', async () => {
    const text = ': keep-alive\n\ndata: {"word":"café ✓"}\n\n: keep-alive\n\ndata: {"n":2}\n\n';
    const bytes = new TextEncoder().encode(text);
    // Every possible single cut, including inside the two-byte é and the three-byte ✓.
    for (let cut = 1; cut < bytes.length; cut++) {
      expect(await collect(split(text, [cut]))).toEqual([{ word: 'café ✓' }, { n: 2 }]);
    }
    // One byte at a time.
    expect(await collect([...bytes].map((b) => Uint8Array.of(b)))).toEqual([{ word: 'café ✓' }, { n: 2 }]);
  });

  it('accepts CRLF line endings, even when the CR and the LF arrive in different chunks', async () => {
    const text = 'data: {"a":1}\r\n\r\n: comment\r\n\r\ndata: {"b":2}\r\n\r\n';
    const crAt = text.indexOf('\r\n\r\ndata: {"b"') + 1;
    expect(await collect(split(text, [crAt]))).toEqual([{ a: 1 }, { b: 2 }]);
    expect(await collect(split(text, [1, 5, 14, 15, 16]))).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('joins the data lines of one event with a newline and ignores event, id and retry fields', async () => {
    const text = 'event: stage\nid: 7\nretry: 1000\ndata: {"a":\ndata:  [1,\ndata:2]}\n\n';
    expect(await collect(split(text, []))).toEqual([{ a: [1, 2] }]);
  });

  it('does not deliver an event whose blank line never arrived, or an event with no data', async () => {
    expect(await collect(split('id: 1\n\ndata: {"half":true}\n', []))).toEqual([]);
  });

  it('rejects when an event is not JSON, after delivering the events before it', async () => {
    const seen: unknown[] = [];
    const body = streamOf(split('data: {"ok":1}\n\ndata: <html>\n\ndata: {"ok":2}\n\n', []));
    await expect(readEventStream(body, (d) => seen.push(d))).rejects.toBeInstanceOf(EventDataError);
    expect(seen).toEqual([{ ok: 1 }]);
  });

  it('stops reading and cancels the stream when the listener throws', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: 1\n\ndata: 2\n\n'));
      },
      cancel() {
        cancelled = true;
      },
    });
    const seen: unknown[] = [];
    await expect(
      readEventStream(body, (d) => {
        seen.push(d);
        throw new Error('stop');
      }),
    ).rejects.toThrow('stop');
    expect(seen).toEqual([1]);
    expect(cancelled).toBe(true);
  });

  it('reads one very large single-line event arriving in many small chunks in linear time', async () => {
    // 8 MB of data on one line, in 512-byte chunks: rescanning or re-joining the pending text on every chunk
    // would touch about 64 GB of characters; reading it once touches 8 MB.
    const big = 'x'.repeat(8 * 1024 * 1024);
    const bytes = new TextEncoder().encode(`data: "${big}"\n\n`);
    const chunks: Uint8Array[] = [];
    for (let at = 0; at < bytes.length; at += 512) chunks.push(bytes.subarray(at, at + 512));
    const started = performance.now();
    const seen = await collect(chunks);
    const ms = performance.now() - started;
    expect(seen).toEqual([big]);
    expect(ms).toBeLessThan(4000);
  }, 60_000);
});
