/**
 * Reads a `text/event-stream` body and hands each event's data, parsed as JSON, to `onEvent`.
 *
 * Lines end in LF or CRLF; a line starting with `:` is a comment (the service's keep-alive); the `data:` lines of
 * one event are joined with a newline; a blank line ends the event; other fields (`event:`, `id:`, `retry:`) are
 * ignored. A character or a line may be split across chunks. An event that never got its blank line is dropped,
 * as the format says. Rejects when an event's data is not JSON or when `onEvent` throws, cancelling the stream.
 */
export async function readEventStream(body: ReadableStream<Uint8Array>, onEvent: (data: unknown) => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let data: string[] = [];

  const line = (text: string): void => {
    if (text === '') {
      if (data.length > 0) {
        const joined = data.join('\n');
        data = [];
        onEvent(JSON.parse(joined));
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
    pending += text;
    let start = 0;
    for (let end = pending.indexOf('\n'); end !== -1; end = pending.indexOf('\n', start)) {
      const raw = pending.slice(start, end);
      line(raw.endsWith('\r') ? raw.slice(0, -1) : raw);
      start = end + 1;
    }
    pending = pending.slice(start);
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
