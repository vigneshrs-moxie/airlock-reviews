import type { Depth, LearnedReply, PackRef, PrSummary, RemoveLearnedBody, RemoveLearnedReply, ServiceStatus } from '@airlock/shared';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { Timers } from '../client/timers';
import { pageWords, type PageReport } from '../state/jump';
import { CommandBox } from './CommandBox';
import { useAnnounce } from './Frame';
import { LearnedList, LearnedStatus, useLearned } from './LearnedList';

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
export function Packs({
  pr, packVersions, paired, fetchStatus, fetchLearned, removeLearned, removeBlocked = null, defaultDepth, onDefaultDepth, depthFailed = false,
  showNotes = null, onShowNotes, notesFailed = false, page = null, onBack, timers,
}: {
  pr: PrSummary | null;
  /** The packs of the review on screen with their versions; empty when no review is on screen. */
  packVersions: readonly PackRef[];
  /** Whether the panel is paired; null when nothing on screen proves it either way. */
  paired: boolean | null;
  fetchStatus: () => Promise<ServiceStatus>;
  /** Reads the learned lines of the packs chosen for a repository. */
  fetchLearned: (repo: string) => Promise<LearnedReply>;
  removeLearned: (body: RemoveLearnedBody) => Promise<RemoveLearnedReply>;
  /** Why a learned line cannot be removed now (offline, read-only); null when it can. */
  removeBlocked?: string | null;
  defaultDepth: Depth | null;
  onDefaultDepth: (depth: Depth | null) => void;
  depthFailed?: boolean;
  /** Whether the review's notes are shown in the diff; null until the setting is read. */
  showNotes?: boolean | null;
  onShowNotes?: (on: boolean) => void;
  /** Storing the notes setting failed, so the screen shows what is stored again and says so. */
  notesFailed?: boolean;
  /** What the last jump found on the GitHub page; null before any jump. */
  page?: PageReport | null;
  onBack: () => void;
  timers?: Timers;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const depthName = useId();
  useEffect(() => { heading.current?.focus(); }, []);
  const learned = useLearned(pr === null ? null : pr.repo, fetchLearned, removeLearned);
  const announce = useAnnounce();
  const noteAt = learned.result?.at;
  // After a removal: the service's note is said, and focus goes to the heading of the pack the line was in.
  useEffect(() => {
    const done = learned.result;
    if (done === null) return;
    announce(done.note);
    (document.getElementById(`pack-title-${done.pack}`) ?? heading.current)?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteAt]);
  // Lines of a pack the pull request does not list are shown under that pack's own title, after the others.
  const shown = pr === null ? [] : pr.packs;
  const extra = learned.view.kind === 'ok'
    ? [...new Map(learned.view.reply.lines.filter((l) => !shown.some((p) => p.id === l.pack)).map((l) => [l.pack, l.packTitle])).entries()].map(([id, title]) => ({ id, title }))
    : [];
  const list = (id: string) => learned.view.kind === 'ok' && (
    <LearnedList
      packId={id} reply={learned.view.reply} blocked={removeBlocked} busy={learned.removing}
      refusal={learned.refusal} onRemove={learned.remove}
    />
  );

  return (
    <div className="packs-screen">
      <div className="row">
        <h2 className="title" tabIndex={-1} ref={heading}>Packs and settings</h2>
        <button type="button" className="btn small" onClick={onBack}>Back</button>
      </div>
      <section className="card" aria-labelledby="packs-list">
        <h3 className="label" id="packs-list">Packs for this repository</h3>
        {learned.result !== null && <p className="notice">{learned.result.note}</p>}
        {pr !== null && <LearnedStatus view={learned.view} reload={() => { void learned.reload(); }} />}
        {pr === null ? <p className="muted">Open a pull request to see its packs.</p> : (
          <ul className="plain">
            {[...pr.packs, ...extra].map((p) => {
              const version = packVersions.find((v) => v.id === p.id)?.version;
              return (
                <li key={p.id}>
                  <div id={`pack-title-${p.id}`} tabIndex={-1}>{p.title}</div>
                  {version !== undefined && <div className="muted">{`version ${versionWords(version)}`}</div>}
                  {list(p.id)}
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
      <section className="card" aria-labelledby="packs-notes">
        <h3 className="label" id="packs-notes">Notes</h3>
        <label className="switch">
          <input
            type="checkbox" role="switch" checked={showNotes !== false} disabled={showNotes === null}
            onChange={() => onShowNotes?.(showNotes === false)}
          />
          <span>Show notes in the diff</span>
        </label>
        {notesFailed && <p role="alert" className="notice">Airlock could not save that setting.</p>}
      </section>
      <section className="card" aria-labelledby="packs-page">
        <h3 className="label" id="packs-page">GitHub page</h3>
        <p className={page === null ? 'muted' : undefined}>{pageWords(page)}</p>
      </section>
    </div>
  );
}
