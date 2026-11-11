import type { Depth, PackRef, PrSummary, ServiceStatus } from '@airlock/shared';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { Timers } from '../client/timers';
import { CommandBox } from './CommandBox';

export const UNREACHABLE = 'Airlock could not reach its service.';
export const UNPAIR_COMMAND = 'npm run service -- unpair';

/** A commit is shown by its first seven characters; any other version as written. */
export const versionWords = (version: string): string => (/^[0-9a-f]{40}$/.test(version) ? version.slice(0, 7) : version);

type Fetched = { kind: 'loading' } | { kind: 'failed' } | { kind: 'ok'; status: ServiceStatus };

const CHOICES: { depth: Depth | null; name: string }[] = [
  { depth: null, name: 'Suggested for each pull request' },
  { depth: 'quick', name: 'Quick' },
  { depth: 'standard', name: 'Standard' },
  { depth: 'deep', name: 'Deep' },
];

function ServiceSection({ fetchStatus }: { fetchStatus: () => Promise<ServiceStatus> }) {
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

  return (
    <section className="card" aria-labelledby="packs-service">
      <h3 className="label" id="packs-service">Service</h3>
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

/** Which packs apply and how the panel is connected; replaces the panel's content until Back. */
export function Packs({ pr, packVersions, paired, fetchStatus, defaultDepth, onDefaultDepth, depthFailed = false, onBack, timers }: {
  pr: PrSummary | null;
  /** The packs of the review on screen with their versions; empty when no review is on screen. */
  packVersions: readonly PackRef[];
  /** Whether the panel is paired; null when nothing on screen proves it either way. */
  paired: boolean | null;
  fetchStatus: () => Promise<ServiceStatus>;
  defaultDepth: Depth | null;
  onDefaultDepth: (depth: Depth | null) => void;
  depthFailed?: boolean;
  onBack: () => void;
  timers?: Timers;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const depthName = useId();
  useEffect(() => { heading.current?.focus(); }, []);

  return (
    <div className="packs-screen">
      <div className="row">
        <h2 className="title" tabIndex={-1} ref={heading}>Packs and settings</h2>
        <button type="button" className="btn small" onClick={onBack}>Back</button>
      </div>
      <section className="card" aria-labelledby="packs-list">
        <h3 className="label" id="packs-list">Packs for this repository</h3>
        {pr === null ? <p className="muted">Open a pull request to see its packs.</p> : (
          <ul className="plain">
            {pr.packs.map((p) => {
              const version = packVersions.find((v) => v.id === p.id)?.version;
              return (
                <li key={p.id}>
                  <div>{p.title}</div>
                  {version !== undefined && <div className="muted">{`version ${versionWords(version)}`}</div>}
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <ServiceSection fetchStatus={fetchStatus} />
      <section className="card" aria-labelledby="packs-pairing">
        <h3 className="label" id="packs-pairing">Pairing</h3>
        {paired === null ? <p className="muted">Not known yet.</p> : paired ? (
          <>
            <p>This panel is paired.</p>
            <CommandBox intro="To unpair, in the airlock-reviews folder run:" command={UNPAIR_COMMAND} {...(timers ? { timers } : {})} />
          </>
        ) : <p>Not paired yet.</p>}
      </section>
      <section className="card" aria-labelledby="packs-depth">
        <h3 className="label" id="packs-depth">Default depth</h3>
        <div role="radiogroup" aria-labelledby="packs-depth">
          {CHOICES.map((c) => (
            <label key={c.name} className="choice">
              <input type="radio" name={depthName} checked={defaultDepth === c.depth} onChange={() => onDefaultDepth(c.depth)} />
              <span>{c.name}</span>
            </label>
          ))}
        </div>
        {depthFailed && <p role="alert" className="notice">Airlock could not save that setting.</p>}
      </section>
    </div>
  );
}
