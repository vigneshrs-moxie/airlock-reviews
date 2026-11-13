import type { Depth, LearnedReply, PackRef, PrSummary, RemoveLearnedBody, RemoveLearnedReply, ServiceStatus } from '@airlock/shared';
import { useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import type { Timers } from '../client/timers';
import type { PageReport } from '../state/jump';
import { SIZES, SIZE_LABEL, type SizeSetting } from '../state/size';
import { ChevronRight, ScreenHead } from './Frame';
import { learnedCount, useLearned } from './LearnedList';
import { Packs } from './Packs';
import { ServiceInfo, serviceLine, useServiceStatus } from './ServiceInfo';

export const NOT_SAVED = 'Airlock could not save that setting.';
export const SIZE_NOTE = 'Changes the size of the text in the panel. Saved on this computer.';
export const NOTES_NOTE = 'Private notes under the lines of Files changed. Only you see them.';
export const NO_PR_PACKS = 'Open a pull request to see its packs.';
export const UNPAIRED_PACKS = 'Pair Airlock to see its packs.';

const DEPTHS: { depth: Depth | null; name: string }[] = [
  { depth: null, name: 'Suggested for each pull request' },
  { depth: 'quick', name: 'Quick' },
  { depth: 'standard', name: 'Standard' },
  { depth: 'deep', name: 'Deep' },
];

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/**
 * The Packs row's line: how many packs this repository has, and how many lines were learned once they are read. An
 * unpaired panel cannot read its packs, whether or not a pull request is open.
 */
export function packsLine(pr: PrSummary | null, lines: number | null, paired: boolean | null = null): string {
  if (paired === false) return UNPAIRED_PACKS;
  if (pr === null) return NO_PR_PACKS;
  const packs = `${plural(pr.packs.length, 'pack', 'packs')} for this repository`;
  return lines === null ? packs : `${packs} · ${plural(lines, 'line', 'lines')} learned`;
}

export interface SettingsProps {
  pr: PrSummary | null;
  /** The packs of the review on screen with their versions; empty when no review is on screen. */
  packVersions: readonly PackRef[];
  /** Whether the panel is paired; null when nothing on screen proves it either way. */
  paired: boolean | null;
  fetchStatus: () => Promise<ServiceStatus>;
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
  notesFailed?: boolean;
  /** What the last jump found on the GitHub page; null before any jump. */
  page?: PageReport | null;
  size: SizeSetting;
  onBack: () => void;
  /** Show the tour again: Settings closes and the tour opens at its first step. */
  onTour?: () => void;
  timers?: Timers;
}

/** One row that opens another screen: its name, one line under it, and a chevron. */
function OpenRow({ title, line, onOpen, rowRef }: { title: string; line: string; onOpen: () => void; rowRef?: RefObject<HTMLButtonElement | null> }) {
  const titleId = useId();
  const lineId = useId();
  return (
    <button type="button" className="ap-set" aria-labelledby={titleId} aria-describedby={lineId} onClick={onOpen} ref={rowRef}>
      <span className="grow">
        <b id={titleId}>{title}</b>
        <span className="muted" id={lineId}>{line}</span>
      </span>
      <span className="ap-go"><ChevronRight /></span>
    </button>
  );
}

/** The four sizes as one control; the whole panel changes at once. */
function SizeControl({ size }: { size: SizeSetting }) {
  const { size: shown, failed } = useSyncExternalStore(size.subscribe, size.current);
  const titleId = useId();
  const name = useId();
  return (
    <div className="ap-group">
      <b id={titleId}>Text size</b>
      <div className="ap-seg" role="radiogroup" aria-labelledby={titleId}>
        {SIZES.map((s) => (
          <label key={s} className={s === shown ? 'on' : undefined}>
            <input type="radio" name={name} checked={s === shown} onChange={() => size.choose(s)} />
            <span>{SIZE_LABEL[s]}</span>
          </label>
        ))}
      </div>
      {/* What a finding and its buttons look like at this size; a picture only, so it is hidden from screen readers. */}
      <div className="ap-preview" aria-hidden="true">
        <div className="ap-row">
          <span className="ap-sev sev-fix">Fix</span>
          <span className="ap-row-main">
            <span className="ap-row-title">Tests pass without testing the safety rules</span>
            <span className="ap-row-sub">tests/safety.test.js:14</span>
          </span>
        </div>
        <div className="ap-preview-buttons">
          <span className="btn primary">Copy fix prompt</span>
          <span className="btn">Dismiss</span>
        </div>
      </div>
      <p className="muted">{SIZE_NOTE}</p>
      {failed && <p role="alert" className="notice">{NOT_SAVED}</p>}
    </div>
  );
}

/** The Settings list itself: Display, On GitHub, Reviews and Help. */
function SettingsList({
  defaultDepth, onDefaultDepth, depthFailed = false, showNotes = null, onShowNotes, notesFailed = false, size, onBack,
  onTour, packsLineText, serviceLineText, onPacks, onService, packsRow, serviceRow,
}: Pick<SettingsProps, 'defaultDepth' | 'onDefaultDepth' | 'depthFailed' | 'showNotes' | 'onShowNotes' | 'notesFailed' | 'size' | 'onBack' | 'onTour'> & {
  packsLineText: string;
  serviceLineText: string;
  onPacks: () => void;
  onService: () => void;
  packsRow: RefObject<HTMLButtonElement | null>;
  serviceRow: RefObject<HTMLButtonElement | null>;
}) {
  const ids = { display: useId(), github: useId(), reviews: useId(), help: useId(), depth: useId(), notes: useId(), notesNote: useId() };
  const depthName = useId();
  return (
    <>
      <ScreenHead title="Settings" onBack={onBack} />
      <section className="settings-group" aria-labelledby={ids.display}>
        <h3 className="label" id={ids.display}>Display</h3>
        <SizeControl size={size} />
      </section>
      <section className="settings-group" aria-labelledby={ids.github}>
        <h3 className="label" id={ids.github}>On GitHub</h3>
        <label className="ap-set">
          <span className="grow">
            <b id={ids.notes}>Notes in the diff</b>
            <span className="muted" id={ids.notesNote}>{NOTES_NOTE}</span>
          </span>
          <input
            type="checkbox" role="switch" className="ap-switch" aria-labelledby={ids.notes} aria-describedby={ids.notesNote}
            checked={showNotes !== false} disabled={showNotes === null} onChange={() => onShowNotes?.(showNotes === false)}
          />
        </label>
        {notesFailed && <p role="alert" className="notice">{NOT_SAVED}</p>}
      </section>
      <section className="settings-group" aria-labelledby={ids.reviews}>
        <h3 className="label" id={ids.reviews}>Reviews</h3>
        <div className="ap-set ap-set-block">
          <b id={ids.depth}>Default depth</b>
          <div role="radiogroup" aria-labelledby={ids.depth}>
            {DEPTHS.map((c) => (
              <label key={c.name} className="choice">
                <input type="radio" name={depthName} checked={defaultDepth === c.depth} onChange={() => onDefaultDepth(c.depth)} />
                <span>{c.name}</span>
              </label>
            ))}
          </div>
          {depthFailed && <p role="alert" className="notice">{NOT_SAVED}</p>}
        </div>
        <OpenRow title="Packs and learned lines" line={packsLineText} onOpen={onPacks} rowRef={packsRow} />
      </section>
      <section className="settings-group" aria-labelledby={ids.help}>
        <h3 className="label" id={ids.help}>Help</h3>
        {onTour && <OpenRow title="Show the tour again" line="Three short steps." onOpen={onTour} />}
        <OpenRow title="Service" line={serviceLineText} onOpen={onService} rowRef={serviceRow} />
      </section>
    </>
  );
}

type At = 'settings' | 'packs' | 'service';

/**
 * Settings, and the Packs and Service screens it opens. It replaces the panel's content until Back; Back from Packs or
 * Service returns to Settings with focus on the row that opened it. The service's status and the learned lines are read
 * once when Settings opens and shared by its screens, so a removal or Check again shows on the rows too.
 */
export function Settings(props: SettingsProps) {
  const { pr, packVersions, paired, fetchStatus, fetchLearned, removeLearned, removeBlocked = null, page = null, onBack, timers } = props;
  const [at, setAt] = useState<At>('settings');
  const status = useServiceStatus(fetchStatus);
  const learned = useLearned(pr === null ? null : pr.repo, fetchLearned, removeLearned);
  const packsRow = useRef<HTMLButtonElement>(null);
  const serviceRow = useRef<HTMLButtonElement>(null);
  const was = useRef<At>(at);
  useLayoutEffect(() => {
    if (at === 'settings' && was.current !== 'settings') (was.current === 'packs' ? packsRow : serviceRow).current?.focus();
    was.current = at;
  }, [at]);
  const back = (): void => setAt('settings');
  return (
    <>
      <div className="settings-screen" hidden={at !== 'settings'}>
        <SettingsList
          {...props} onBack={onBack}
          packsLineText={packsLine(pr, learnedCount(learned), paired)} serviceLineText={serviceLine(status.fetched, paired)}
          onPacks={() => setAt('packs')} onService={() => setAt('service')} packsRow={packsRow} serviceRow={serviceRow}
        />
      </div>
      {at === 'packs' && <Packs pr={pr} packVersions={packVersions} learned={learned} removeBlocked={removeBlocked} onBack={back} />}
      {at === 'service' && (
        <ServiceInfo fetched={status.fetched} check={status.check} paired={paired} page={page} onBack={back} {...(timers ? { timers } : {})} />
      )}
    </>
  );
}
