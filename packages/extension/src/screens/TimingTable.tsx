import type { ReviewDocument, StageTiming } from '@airlock/shared';
import { stageWords } from '../state/stage-words';

const seconds = (ms: number): string => (ms / 1000).toFixed(1);
const count = (n: number): string => n.toLocaleString('en-US');
const tokens = (t: StageTiming): number => t.inputTokens + t.outputTokens;

/** A stage took time when it ran for a while or made a model run. */
export const tookTime = (t: StageTiming): boolean => t.ms > 0 || t.agentRuns > 0;

/** A length of time in words: "42 s", "5 min 25 s", "6 min", "1 h 4 min". */
export function durationWords(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const min = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  if (h > 0) return min === 0 ? `${h} h` : `${h} h ${min} min`;
  if (min > 0) return sec === 0 ? `${min} min` : `${min} min ${sec} s`;
  return `${sec} s`;
}

const at = (iso: string | undefined): number | null => {
  if (iso === undefined) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
};

/**
 * How long the review took, from the first stage's start to the last stage's end when the timings say (stages overlap, so
 * it is not the sum of their times), else from the review's start to its document; null when neither is known.
 */
export function reviewTime(doc: Pick<ReviewDocument, 'timings' | 'startedAt' | 'createdAt'>): string | null {
  const starts = doc.timings.map((t) => at(t.startedAt)).filter((t): t is number => t !== null);
  const ends = doc.timings.map((t) => at(t.finishedAt)).filter((t): t is number => t !== null);
  if (starts.length > 0 && ends.length > 0) {
    const span = Math.max(...ends) - Math.min(...starts);
    if (span >= 0) return durationWords(span);
  }
  const start = at(doc.startedAt);
  const end = at(doc.createdAt);
  return start !== null && end !== null && end >= start ? durationWords(end - start) : null;
}

/** One row per stage that took time, then the total, which the rows add up to. */
export function TimingTable({ timings }: { timings: readonly StageTiming[] }) {
  const sum = (pick: (t: StageTiming) => number): number => timings.reduce((n, t) => n + pick(t), 0);
  return (
    <table className="timing">
      <thead>
        <tr><th scope="col">Stage</th><th scope="col">Seconds</th><th scope="col">Runs</th><th scope="col">Tokens</th></tr>
      </thead>
      <tbody>
        {timings.filter(tookTime).map((t) => (
          <tr key={t.stage}>
            <th scope="row">{stageWords(t.stage)}</th><td>{seconds(t.ms)}</td><td>{t.agentRuns > 0 ? count(t.agentRuns) : '–'}</td><td>{t.agentRuns > 0 ? count(tokens(t)) : '–'}</td>
          </tr>
        ))}
        <tr>
          <th scope="row">Total</th><td>{seconds(sum((t) => t.ms))}</td><td>{count(sum((t) => t.agentRuns))}</td><td>{count(sum(tokens))}</td>
        </tr>
      </tbody>
    </table>
  );
}
