import { HelloSchema } from '@airlock/shared';
import { useEffect, useState } from 'react';
import { SERVICE_URL } from '../config';

type Line = { kind: 'checking' } | { kind: 'connected'; version: string } | { kind: 'down' } | { kind: 'unexpected' };

export function Panel({ fetchImpl = fetch, timeoutMs = 5000 }: { fetchImpl?: typeof fetch; timeoutMs?: number }) {
  const [line, setLine] = useState<Line>({ kind: 'checking' });

  useEffect(() => {
    let live = true;
    const set = (next: Line): void => {
      if (live) setLine(next);
    };
    fetchImpl(`${SERVICE_URL}/hello`, { signal: AbortSignal.timeout(timeoutMs) })
      .then(async (res) => {
        const body: unknown = res.ok ? await res.json().catch(() => null) : null;
        const hello = HelloSchema.safeParse(body);
        set(hello.success ? { kind: 'connected', version: hello.data.version } : { kind: 'unexpected' });
      })
      .catch(() => set({ kind: 'down' }));
    return () => {
      live = false;
    };
  }, [fetchImpl, timeoutMs]);

  switch (line.kind) {
    case 'checking':
      return <p>Airlock service: checking…</p>;
    case 'connected':
      return <p>{`Airlock service: connected (version ${line.version})`}</p>;
    case 'down':
      return <p>Airlock service: not running</p>;
    case 'unexpected':
      return <p>Airlock service: unexpected reply</p>;
  }
}
