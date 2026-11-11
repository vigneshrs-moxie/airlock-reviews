import type { StageTiming } from '@airlock/shared';
import { stageWords } from '../state/stage-words';

const seconds = (ms: number): string => (ms / 1000).toFixed(1);
const count = (n: number): string => n.toLocaleString('en-US');
const tokens = (t: StageTiming): number => t.inputTokens + t.outputTokens;

/** A stage took time when it ran for a while or made a model run. */
export const tookTime = (t: StageTiming): boolean => t.ms > 0 || t.agentRuns > 0;

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
