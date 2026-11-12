/** An event whose data is not JSON. */
export class EventDataError extends Error {
  constructor() {
    super('An event from the service is not JSON.');
    this.name = 'EventDataError';
  }
}

/**
 * Reads a `text/event-stream` body and hands each event's data, parsed as JSON, to `onEvent`.
 *
 * Lines end in LF or CRLF; a line starting with `:` is a comment (the service's keep-alive); the `data:` lines of
 * one event are joined with a newline; a blank line ends the event; other fields (`event:`, `id:`, `retry:`) are
 * ignored. A character or a line may be split across chunks; each chunk is scanned once, so a very long line costs
 * no more than its length. An event that never got its blank line is dropped, as the format says. Rejects with
 * `EventDataError` when an event's data is not JSON, or with whatever `onEvent` or the stream threw, cancelling the
 * stream.
 */
export async function readEventStream(body: ReadableStream<Uint8Array>, onEvent: (data: unknown) => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let partial: string[] = [];
  let data: string[] = [];

  const line = (text: string): void => {
    if (text === '') {
      if (data.length > 0) {
        const joined = data.join('\n');
        data = [];
        let parsed: unknown;
        try {
          parsed = JSON.parse(joined);
        } catch {
          throw new EventDataError();
        }
        onEvent(parsed);
      }
      return;
    }
    if (text.startsWith(':')) return;
    const colon = text.indexOf(':');
    const field = colon === -1 ? text : text.slice(0, colon);
    if (field !== 'data') return;
    const value = colon === -1 ? '' : text.slice(colon + 1);
    data.push(value.startsWith(' ') ? value.slice(1) : value);
  };

  const take = (text: string): void => {
    let start = 0;
    for (let end = text.indexOf('\n'); end !== -1; end = text.indexOf('\n', start)) {
      partial.push(text.slice(start, end));
      const raw = partial.join('');
      partial = [];
      line(raw.endsWith('\r') ? raw.slice(0, -1) : raw);
      start = end + 1;
    }
    if (start < text.length) partial.push(text.slice(start));
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      take(decoder.decode(value, { stream: true }));
    }
    take(decoder.decode());
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}
