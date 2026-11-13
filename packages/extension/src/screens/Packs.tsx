import type { PackRef, PrSummary } from '@airlock/shared';
import { useEffect, useRef } from 'react';
import { ScreenHead, useAnnounce } from './Frame';
import { LearnedList, LearnedStatus, type Learned } from './LearnedList';

/** A commit is shown by its first seven characters; any other version as written. */
export const versionWords = (version: string): string => (/^[0-9a-f]{40}$/.test(version) ? version.slice(0, 7) : version);

export const LEARNED_FROM = 'Lines come from findings you dismissed. Airlock reads them in every later review of this repository.';

/** The packs of this repository and what Airlock learned in them; opened from Settings, and Back returns there. */
export function Packs({ pr, packVersions, learned, removeBlocked = null, onBack }: {
  pr: PrSummary | null;
  /** The packs of the review on screen with their versions; empty when no review is on screen. */
  packVersions: readonly PackRef[];
  /** The learned lines of this repository's packs, read when Settings opened, and their removal. */
  learned: Learned;
  /** Why a learned line cannot be removed now (offline, read-only); null when it can. */
  removeBlocked?: string | null;
  onBack: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const announce = useAnnounce();
  const noteAt = learned.result?.at;
  // A note from a removal made before this screen opened was said then.
  const openedAt = useRef(noteAt);
  // After a removal: the service's note is said, and focus goes to the heading of the pack the line was in.
  useEffect(() => {
    const done = learned.result;
    if (done === null || done.at === openedAt.current) return;
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
      <ScreenHead title="Packs and learned lines" onBack={onBack} headingRef={heading} />
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
      <p className="muted">{LEARNED_FROM}</p>
    </div>
  );
}
