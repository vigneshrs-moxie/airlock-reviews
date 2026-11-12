import type { LearnedKind, LearnedLine, LearnedReply, RemoveLearnedBody, RemoveLearnedReply } from '@airlock/shared';
import { Fragment, useCallback, useEffect, useId, useRef, useState } from 'react';
import { ServiceError } from '../client/service';
import { useAnnounce } from './Frame';
import { Reason, WAIT } from './PostedMark';

export const NOTHING_LEARNED = 'Nothing learned yet.';
export const MANAGED = 'Managed by the team; not edited here.';
export const REMOVE_ASK = 'Remove this line? The reviewer stops following it from the next review.';
export const LEARNED_LOADING = 'Loading what Airlock has learned…';
export const LEARNED_UNREACHABLE = 'Airlock could not reach its service to read what it has learned.';
export const NO_REMOVE_OFFLINE = 'Removing a line needs the Airlock service, which is not answering.';
export const NO_REMOVE_UNPAIRED = 'Removing a line needs this panel to be paired with the Airlock service.';
export const REMOVED = 'Removed.';
/** The team's own pack: its lines are not the person's to edit, whether or not it holds any. */
export const KIT_PACK = 'raj-standard';
/** A pack's count against the cap is shown only for a kind holding more lines than this. */
export const COUNT_SHOWN_OVER = 250;

export type LearnedView =
  | { kind: 'loading' }
  /** `message`: the service's words, or that it could not be reached. */
  | { kind: 'failed'; message: string }
  | { kind: 'ok'; reply: LearnedReply };

const kindWord = (kind: LearnedKind): string => (kind === 'wrong' ? 'Wrong' : 'Product fact');

const whereWords = (line: LearnedLine): string =>
  line.appliesHere ? 'Applies to this repository' : line.repo === null ? 'Not used for this repository' : `Only for ${line.repo}`;

/** What to say of a failed call: a refusal in the service's words, no answer in ours. */
export const failureWords = (error: unknown): string =>
  error instanceof ServiceError && error.kind !== 'offline' ? error.message : LEARNED_UNREACHABLE;

/**
 * The learned lines of the packs chosen for `repo`, read when the screen opens and again on `reload`. While a read is
 * under way after the first, the lines already shown stay. Only the latest read counts.
 */
export function useLearned(repo: string | null, fetchLearned: (repo: string) => Promise<LearnedReply>): { view: LearnedView; reload: () => Promise<void> } {
  const [view, setView] = useState<LearnedView>({ kind: 'loading' });
  const latest = useRef(0);
  const reload = useCallback(async (): Promise<void> => {
    if (repo === null) return;
    const mine = ++latest.current;
    setView((was) => (was.kind === 'ok' ? was : { kind: 'loading' }));
    try {
      const reply = await fetchLearned(repo);
      if (latest.current === mine) setView({ kind: 'ok', reply });
    } catch (error) {
      if (latest.current === mine) setView({ kind: 'failed', message: failureWords(error) });
    }
  }, [repo, fetchLearned]);
  useEffect(() => {
    void reload();
    return () => { latest.current++; };
  }, [reload]);
  return { view, reload };
}

/** Under the pack list's heading: that the lines are loading, or why they could not be read, with a way to read again. */
export function LearnedStatus({ view, reload }: { view: LearnedView; reload: () => void }) {
  if (view.kind === 'loading') return <p className="muted">{LEARNED_LOADING}</p>;
  if (view.kind === 'ok') return null;
  return (
    <div>
      <p role="alert" className="notice">{view.message}</p>
      <button type="button" className="btn small" onClick={reload}>Load again</button>
    </div>
  );
}

function Line({ line, blocked, busy, onRemove }: {
  line: LearnedLine;
  /** Why Remove cannot be pressed now; null when it can. */
  blocked: string | null;
  busy: boolean;
  onRemove: (line: LearnedLine) => void;
}) {
  const [asking, setAsking] = useState(false);
  const textId = useId();
  const whyId = useId();
  const question = useRef<HTMLParagraphElement>(null);
  const remove = useRef<HTMLButtonElement>(null);
  const keep = useRef(false);
  const announce = useAnnounce();
  const why = blocked ?? (busy ? WAIT : null);
  useEffect(() => {
    if (asking) { question.current?.focus(); announce(REMOVE_ASK); }
    else if (keep.current) { keep.current = false; remove.current?.focus(); }
  }, [asking, announce]);
  return (
    <li className="learned-line">
      <div>
        <span className="muted">{line.date}</span>
        {' '}
        <span className="mark">{kindWord(line.kind)}</span>
      </div>
      <p id={textId}>{line.text}</p>
      <p className="muted">{whereWords(line)}</p>
      {line.removable && (asking ? (
        <>
          <p tabIndex={-1} ref={question}>{REMOVE_ASK}</p>
          <div className="actions">
            <button type="button" className="btn small" disabled={why !== null} onClick={() => { setAsking(false); onRemove(line); }}>Remove</button>
            <button type="button" className="btn small" onClick={() => { keep.current = true; setAsking(false); }}>Keep</button>
          </div>
        </>
      ) : (
        <>
          <button
            type="button" className="btn small" ref={remove} disabled={why !== null}
            aria-describedby={why === null ? textId : `${textId} ${whyId}`} onClick={() => setAsking(true)}
          >
            Remove
          </button>
          {why !== null && <Reason id={whyId} text={why} />}
        </>
      ))}
    </li>
  );
}

/** One pack's learned lines, newest first as the service sent them, grouped by the pack's id. */
export function LearnedList({ repo, packId, reply, blocked, remove, reload }: {
  /** The repository the panel is on, which the service checks the removal against. */
  repo: string;
  packId: string;
  reply: LearnedReply;
  blocked: string | null;
  remove: (body: RemoveLearnedBody) => Promise<RemoveLearnedReply>;
  reload: () => Promise<void>;
}) {
  const lines = reply.lines.filter((l) => l.pack === packId);
  const managed = packId === KIT_PACK || lines.some((l) => !l.removable);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<{ key: string; message: string } | null>(null);
  const noteRef = useRef<HTMLParagraphElement>(null);
  const announce = useAnnounce();
  const gone = useRef(false);
  useEffect(() => () => { gone.current = true; }, []);
  useEffect(() => { if (note !== null) { announce(note); noteRef.current?.focus(); } }, [note, announce]);

  const onRemove = (line: LearnedLine): void => {
    if (busy || blocked !== null) return;
    setBusy(true);
    setNote(null);
    setRefusal(null);
    remove({ repo, pack: line.pack, kind: line.kind, key: line.key }).then(
      async (done) => {
        await reload();
        if (gone.current) return;
        setBusy(false);
        setNote(done.note ?? REMOVED);
      },
      (error: unknown) => {
        if (gone.current) return;
        setBusy(false);
        setRefusal({ key: line.key, message: failureWords(error) });
      },
    );
  };

  const counts = (['wrong', 'product-knowledge'] as const)
    .map((kind) => ({ kind, n: lines.filter((l) => l.kind === kind).length }))
    .filter((c) => c.n > COUNT_SHOWN_OVER);

  return (
    <div className="learned">
      {note !== null && <p className="notice" tabIndex={-1} ref={noteRef}>{note}</p>}
      {managed && <p className="muted">{MANAGED}</p>}
      {lines.length === 0 && !managed && <p className="muted">{NOTHING_LEARNED}</p>}
      {counts.map((c) => (
        <p key={c.kind} className="muted">{kindWord(c.kind)}: <span>{`${c.n} of ${reply.cap} lines`}</span></p>
      ))}
      {lines.length > 0 && (
        <ul className="plain">
          {lines.map((l) => (
            <Fragment key={`${l.kind}:${l.key}`}>
              <Line line={l} blocked={blocked} busy={busy} onRemove={onRemove} />
              {refusal !== null && refusal.key === l.key && <p role="alert" className="notice">{refusal.message}</p>}
            </Fragment>
          ))}
        </ul>
      )}
    </div>
  );
}
