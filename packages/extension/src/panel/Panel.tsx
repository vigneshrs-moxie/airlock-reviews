import { HelloSchema } from '@airlock/shared';
import { useEffect, useState } from 'react';
import { SERVICE_URL } from '../config';

type Line = { kind: 'checking' } | { kind: 'connected'; version: string } | { kind: 'down' } | { kind: 'unexpected' };

export function Panel({ fetchImpl = fetch }: { fetchImpl?: typeof fetch }) {
  const [line, setLine] = useState<Line>({ kind: 'checking' });

  useEffect(() => {
    let live = true;
    const set = (next: Line): void => {
      if (live) setLine(next);
    };
    fetchImpl(`${SERVICE_URL}/hello`)
      .then(async (res) => {
        const hello = HelloSchema.safeParse(await res.json().catch(() => null));
        set(hello.success ? { kind: 'connected', version: hello.data.version } : { kind: 'unexpected' });
      })
      .catch(() => set({ kind: 'down' }));
    return () => {
      live = false;
    };
  }, [fetchImpl]);

  switch (line.kind) {
    case 'checking':
      return <p>Airlock service: checking</p>;
    case 'connected':
      return <p>{`Airlock service: connected (version ${line.version})`}</p>;
    case 'down':
      return <p>Airlock service: not running</p>;
    case 'unexpected':
      return <p>Airlock service: unexpected reply</p>;
  }
}
