import type { StageTiming } from '@airlock/shared';
import { stageWords } from '../state/stage-words';

const seconds = (ms: number): string => (ms / 1000).toFixed(1);
const count = (n: number): string => n.toLocaleString('en-US');
const tokens = (t: StageTiming): number => t.inputTokens + t.outputTokens;

/** One row per stage that made a model run, then the total over every stage. */
export function TimingTable({ timings }: { timings: readonly StageTiming[] }) {
  const sum = (pick: (t: StageTiming) => number): number => timings.reduce((n, t) => n + pick(t), 0);
  return (
    <table className="timing">
      <thead>
        <tr><th scope="col">Stage</th><th scope="col">Seconds</th><th scope="col">Runs</th><th scope="col">Tokens</th></tr>
      </thead>
      <tbody>
        {timings.filter((t) => t.agentRuns > 0).map((t) => (
          <tr key={t.stage}>
            <th scope="row">{stageWords(t.stage)}</th><td>{seconds(t.ms)}</td><td>{count(t.agentRuns)}</td><td>{count(tokens(t))}</td>
          </tr>
        ))}
        <tr>
          <th scope="row">Total</th><td>{seconds(sum((t) => t.ms))}</td><td>{count(sum((t) => t.agentRuns))}</td><td>{count(sum(tokens))}</td>
        </tr>
      </tbody>
    </table>
  );
}
