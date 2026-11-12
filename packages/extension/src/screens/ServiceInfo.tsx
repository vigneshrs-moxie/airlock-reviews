import type { ServiceStatus } from '@airlock/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Timers } from '../client/timers';
import { pageWords, type PageReport } from '../state/jump';
import { CommandBox } from './CommandBox';
import { ScreenHead } from './Frame';

export const UNREACHABLE = 'Airlock could not reach its service.';
export const UNPAIR_COMMAND = 'npm run service -- unpair';

export type Fetched = { kind: 'loading' } | { kind: 'failed' } | { kind: 'ok'; status: ServiceStatus };

/** The service's status: read when the Settings screen opens, and again on Check again. Only the latest read counts. */
export function useServiceStatus(fetchStatus: () => Promise<ServiceStatus>): { fetched: Fetched; check: () => void } {
  const [fetched, setFetched] = useState<Fetched>({ kind: 'loading' });
  const latest = useRef(0);
  const check = useCallback((): void => {
    const mine = ++latest.current;
    setFetched({ kind: 'loading' });
    fetchStatus().then(
      (status) => { if (latest.current === mine) setFetched({ kind: 'ok', status }); },
      () => { if (latest.current === mine) setFetched({ kind: 'failed' }); },
    );
  }, [fetchStatus]);
  useEffect(() => {
    check();
    return () => { latest.current++; };
  }, [check]);
  return { fetched, check };
}

/** The Service row's one line: each part from what is known. */
export function serviceLine(fetched: Fetched, paired: boolean | null): string {
  if (fetched.kind === 'loading') return 'Checking…';
  if (fetched.kind === 'failed') return paired === false ? 'Not paired' : UNREACHABLE;
  const { claude, gh } = fetched.status;
  return [
    'Running',
    ...(paired === null ? [] : [paired ? 'paired' : 'not paired']),
    claude ? 'Claude found' : 'Claude not found',
    gh ? 'GitHub signed in' : 'GitHub not signed in',
  ].join(' · ');
}

function ServiceSection({ fetched, check }: { fetched: Fetched; check: () => void }) {
  return (
    <section className="card" aria-labelledby="service-service">
      <h3 className="label" id="service-service">Service</h3>
      {fetched.kind === 'loading' && <p className="muted">Checking…</p>}
      {fetched.kind === 'failed' && <p role="alert" className="notice">{UNREACHABLE}</p>}
      {fetched.kind === 'ok' && (
        <ul className="plain">
          <li>{`Running, version ${fetched.status.version}`}</li>
          <li>{fetched.status.claude ? 'Claude: found' : 'Claude: not found'}</li>
          <li>{fetched.status.gh ? 'GitHub command: signed in' : 'GitHub command: not signed in'}</li>
          {fetched.status.running.map((r) => <li key={r.runId}>{`${r.repo} #${r.number}`}</li>)}
        </ul>
      )}
      <button type="button" className="btn small" disabled={fetched.kind === 'loading'} onClick={check}>Check again</button>
    </section>
  );
}

/** How the panel is connected: the service, the pairing and what the last jump found on GitHub's page. Back returns to Settings. */
export function ServiceInfo({ fetched, check, paired, page = null, onBack, timers }: {
  fetched: Fetched;
  check: () => void;
  /** Whether the panel is paired; null when nothing on screen proves it either way. */
  paired: boolean | null;
  /** What the last jump found on the GitHub page; null before any jump. */
  page?: PageReport | null;
  onBack: () => void;
  timers?: Timers;
}) {
  return (
    <div className="service-screen">
      <ScreenHead title="Service" onBack={onBack} />
      <ServiceSection fetched={fetched} check={check} />
      <section className="card" aria-labelledby="service-pairing">
        <h3 className="label" id="service-pairing">Pairing</h3>
        {paired === null ? <p className="muted">Not known yet.</p> : paired ? (
          <>
            <p>This panel is paired.</p>
            <CommandBox intro="To unpair, in the airlock-reviews folder run:" command={UNPAIR_COMMAND} {...(timers ? { timers } : {})} />
          </>
        ) : <p>Not paired yet.</p>}
      </section>
      <section className="card" aria-labelledby="service-page">
        <h3 className="label" id="service-page">GitHub page</h3>
        <p className={page === null ? 'muted' : undefined}>{pageWords(page)}</p>
      </section>
    </div>
  );
}
