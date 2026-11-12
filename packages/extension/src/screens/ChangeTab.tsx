import type { ReviewDocument, Tier } from '@airlock/shared';
import type { Timers } from '../client/timers';
import { BriefBlock, briefPoints, type MergeOf } from './BriefBlock';
import { Collapsible } from './Collapsible';
import { CopyButton } from './CopyButton';
import { MapBlock } from './MapBlock';

export type ChangeFold = 'what' | 'questions' | 'whose' | 'checks' | 'text' | 'files';

const counted = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** The paths the change map lists, in its order. */
const mapPaths = (doc: ReviewDocument): Set<string> =>
  new Set([...doc.map.cohorts.flatMap((c) => c.layers.flatMap((l) => l.files)), ...doc.map.standalone]);

/**
 * The Change tab: what the pull request does in one sentence, then folds, each with its count and each left out when it has
 * nothing: what it does in full, then, before you merge, the questions for the author, whose call, the checks after merge,
 * the text for the pull request, and the files in reading order.
 */
export function ChangeTab({ doc, merge, folds, onFold, timers }: {
  doc: ReviewDocument;
  merge?: MergeOf | undefined;
  folds: ReadonlySet<string>;
  onFold: (key: ChangeFold) => void;
  timers?: Timers | undefined;
}) {
  const t = timers ? { timers } : {};
  const inShort = doc.brief.inShort !== undefined && doc.brief.inShort.trim() !== '' ? doc.brief.inShort : doc.brief.whatItDoes[0];
  const points = briefPoints(doc.brief);
  const files = doc.files.length > 0 ? doc.files.length : mapPaths(doc).size;
  const tiers = new Map<string, Tier>(doc.files.map((f) => [f.path, f.tier]));
  const hasMap = doc.map.cohorts.length > 0 || doc.map.standalone.length > 0;
  const text = doc.selfReviewText.trim() !== '';
  const beforeMerge = doc.questions.length > 0 || doc.whoseCall.length > 0 || doc.checksAfterMerge.length > 0 || text || hasMap;
  const fold = (key: ChangeFold) => ({ open: folds.has(key), onToggle: () => onFold(key) });
  return (
    <>
      {inShort !== undefined && (
        <div className="ap-group">
          <h3 className="label">In short</h3>
          <p className="ap-short">{inShort}</p>
        </div>
      )}
      {points > 0 && (
        <Collapsible title="What it does" count={counted(points, 'point', 'points')} {...fold('what')}>
          <BriefBlock brief={doc.brief} nested {...(merge === undefined ? {} : { merge })} />
        </Collapsible>
      )}
      {beforeMerge && <h3 className="label ap-label-gap">Before you merge</h3>}
      {doc.questions.length > 0 && (
        <Collapsible title="Questions for the author" count={String(doc.questions.length)} {...fold('questions')}>
          <ul className="plain ap-points">{doc.questions.map((q, i) => <li key={i}>{q.text}</li>)}</ul>
        </Collapsible>
      )}
      {doc.whoseCall.length > 0 && (
        <Collapsible title="Whose call" count={String(doc.whoseCall.length)} {...fold('whose')}>
          <ul className="plain ap-points">{doc.whoseCall.map((line, i) => <li key={i}>{line}</li>)}</ul>
        </Collapsible>
      )}
      {doc.checksAfterMerge.length > 0 && (
        <Collapsible title="Check after merge" count={counted(doc.checksAfterMerge.length, 'step', 'steps')} {...fold('checks')}>
          <ol className="steps">{doc.checksAfterMerge.map((line, i) => <li key={i}>{line}</li>)}</ol>
        </Collapsible>
      )}
      {text && (
        <Collapsible title="Text for your pull request" count="copy" {...fold('text')}>
          <div className="quote">{doc.selfReviewText}</div>
          <div><CopyButton text={() => doc.selfReviewText} label="Copy" {...t} /></div>
        </Collapsible>
      )}
      {hasMap && (
        <Collapsible title="Files" count={String(files)} {...fold('files')}>
          <MapBlock map={doc.map} tiers={tiers} nested />
        </Collapsible>
      )}
    </>
  );
}
