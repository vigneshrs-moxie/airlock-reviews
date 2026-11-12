import type { LearnedKind, LearnedLine, LearnedReply, RemoveLearnedBody, RemoveLearnedReply } from '@airlock/shared';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
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

export interface Refusal { pack: string; kind: LearnedKind; key: string; message: string }

/**
 * The learned lines of the packs chosen for `repo`, read when the screen opens and again after a removal, and the
 * removal itself. Only the latest read counts. A different repository drops the old lines at once. The result of a
 * removal (`result`) and a refusal live here, not in the lists, so they outlast a re-read that fails.
 */
export function useLearned(
  repo: string | null,
  fetchLearned: (repo: string) => Promise<LearnedReply>,
  removeLearned: (body: RemoveLearnedBody) => Promise<RemoveLearnedReply>,
): {
  view: LearnedView;
  reload: () => Promise<void>;
  removing: boolean;
  /** The service's note on the last removal that went through (or `Removed.`), and the pack it was in. */
  result: { note: string; pack: string; at: number } | null;
  refusal: (Refusal & { at: number }) | null;
  remove: (line: LearnedLine) => void;
} {
  const [view, setView] = useState<LearnedView>({ kind: 'loading' });
  const [removing, setRemoving] = useState(false);
  const [result, setResult] = useState<{ note: string; pack: string; at: number } | null>(null);
  const [refusal, setRefusal] = useState<(Refusal & { at: number }) | null>(null);
  const latest = useRef(0);
  const inFlight = useRef(false);
  const alive = useRef(false);
  const counter = useRef(0);
  // Set false in the body: under StrictMode the cleanup runs once and the effect runs again.
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const read = useCallback(async (keep: boolean): Promise<void> => {
    if (repo === null) return;
    const mine = ++latest.current;
    setView((was) => (keep && was.kind === 'ok' ? was : { kind: 'loading' }));
    try {
      const reply = await fetchLearned(repo);
      if (latest.current === mine) setView({ kind: 'ok', reply });
    } catch (error) {
      if (latest.current === mine) setView({ kind: 'failed', message: failureWords(error) });
    }
  }, [repo, fetchLearned]);
  useEffect(() => {
    setResult(null);
    setRefusal(null);
    void read(false);
    return () => { latest.current++; };
  }, [read]);
  const reload = useCallback(() => read(false), [read]);
  const remove = (line: LearnedLine): void => {
    if (repo === null || inFlight.current) return;
    inFlight.current = true;
    setRemoving(true);
    setResult(null);
    setRefusal(null);
    const stamp = ++counter.current;
    removeLearned({ repo, pack: line.pack, kind: line.kind, key: line.key }).then(
      async (done) => {
        const note = done.note ?? REMOVED;
        if (alive.current) setResult({ note, pack: line.pack, at: stamp });
        await read(true);
        inFlight.current = false;
        if (alive.current) setRemoving(false);
      },
      (error: unknown) => {
        inFlight.current = false;
        if (!alive.current) return;
        setRemoving(false);
        setRefusal({ pack: line.pack, kind: line.kind, key: line.key, message: failureWords(error), at: stamp });
      },
    );
  };
  return { view, reload, removing, result, refusal, remove };
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

function Line({ line, blocked, busy, refusal, onRemove }: {
  line: LearnedLine;
  /** Why Remove cannot be pressed now; null when it can. */
  blocked: string | null;
  busy: boolean;
  /** The refusal of this line's own removal, if any. */
  refusal: (Refusal & { at: number }) | null;
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
  const stamp = refusal?.at;
  useEffect(() => {
    if (refusal === null) return;
    announce(refusal.message);
    remove.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stamp]);
  const described = why === null ? {} : { 'aria-describedby': whyId };
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
            <button type="button" className="btn small" disabled={why !== null} {...described} onClick={() => { setAsking(false); onRemove(line); }}>Remove</button>
            <button type="button" className="btn small" onClick={() => { keep.current = true; setAsking(false); }}>Keep</button>
          </div>
          {why !== null && <Reason id={whyId} text={why} />}
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
      {refusal !== null && <p role="alert" className="notice">{refusal.message}</p>}
    </li>
  );
}

/** One pack's learned lines, newest first as the service sent them, grouped by the pack's id. */
export function LearnedList({ packId, reply, blocked, busy, refusal, onRemove }: {
  packId: string;
  reply: LearnedReply;
  blocked: string | null;
  /** A removal is in flight. */
  busy: boolean;
  refusal: (Refusal & { at: number }) | null;
  onRemove: (line: LearnedLine) => void;
}) {
  const lines = reply.lines.filter((l) => l.pack === packId);
  const managed = packId === KIT_PACK || lines.some((l) => !l.removable);
  const counts = (['wrong', 'product-knowledge'] as const)
    .map((kind) => ({ kind, n: lines.filter((l) => l.kind === kind).length }))
    .filter((c) => c.n > COUNT_SHOWN_OVER);
  return (
    <div className="learned">
      {managed && <p className="muted">{MANAGED}</p>}
      {lines.length === 0 && !managed && <p className="muted">{NOTHING_LEARNED}</p>}
      {counts.map((c) => (
        <p key={c.kind} className="muted">{kindWord(c.kind)}: <span>{`${c.n} of ${reply.cap} lines`}</span></p>
      ))}
      {lines.length > 0 && (
        <ul className="plain">
          {lines.map((l) => (
            <Line
              key={`${l.kind}:${l.key}`} line={l} blocked={blocked} busy={busy} onRemove={onRemove}
              refusal={refusal !== null && refusal.pack === l.pack && refusal.kind === l.kind && refusal.key === l.key ? refusal : null}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
