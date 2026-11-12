import { checkLearnedText, LEARNED_TEXT_MAX, visibleText, type DismissReason, type Finding, type LatestReply, type PrSummary } from '@airlock/shared';
import { useEffect, useId, useRef, useState } from 'react';
import type { UserAction } from '../state/reduce';
import { dismissalOf, listFindings } from '../state/selection';
import { CopyButton } from './CopyButton';
import { useAnnounce } from './Frame';
import { Sheet } from './Sheet';
import { shortTitle } from './summary';

export const TITLE_IN_DRAFT_MAX = 120;

/** The reasons, as the person chooses them: what each one is, and what Airlock does with it. */
export const REASONS: { reason: DismissReason; name: string; line: string }[] = [
  { reason: 'wrong', name: 'The finding is mistaken', line: 'Airlock saves a line so the same mistake is not made again.' },
  { reason: 'intended', name: 'The code is right for a reason Airlock could not know', line: 'Saved as a fact about your product.' },
  { reason: 'not-now', name: 'Hide it on this pull request only', line: 'Nothing is saved.' },
];

export const DISMISS_LEAD = 'It leaves this review. Nothing is sent to GitHub. You can bring it back under More.';
export const LINE_LABEL = 'The line Airlock will remember';
export const INTENDED_PLACEHOLDER = 'The product fact the reviewer did not know';
export const INSTRUCTION_NOTE = 'Airlock reads this line in every later review of this repository. You can remove it in Settings.';

/** Letters that show as blank space: the Hangul fillers and the braille blank. */
const BLANK_LETTERS = /[\u115F\u1160\u3164\uFFA0\u2800]/g;

/** Only what the person can see, so the line they are asked to save holds nothing they could not read. */
const seen = (text: string): string => visibleText(text).text.replace(BLANK_LETTERS, '');

/** The line the sheet starts from for a reason; built by code, then the person's to edit. */
export function draftFor(reason: DismissReason, finding: Pick<Finding, 'title' | 'path'>): string {
  if (reason !== 'wrong') return '';
  const chars = [...seen(finding.title).replace(/\s+/g, ' ').trim()];
  const title = chars.length <= TITLE_IN_DRAFT_MAX ? chars.join('') : `${chars.slice(0, TITLE_IN_DRAFT_MAX).join('')}…`;
  return `Flagged "${title}" in ${seen(finding.path)}. Wrong because: `;
}

/** A line break typed or pasted becomes a space; nothing else is changed. */
const oneLine = (text: string): string => text.replace(/\r\n|[\r\n\u2028\u2029]/g, ' ');

/** What the person has done in the sheet. Kept by the panel screen, so it outlives the sheet being out of sight. */
export interface SheetDraft {
  finding: Finding;
  /** The review the sheet was opened on; a dismissal is only ever sent to this one. */
  reviewId: string;
  reason: DismissReason | null;
  text: string;
  /** The person has typed in the field, so a change of reason keeps the text. */
  typed: boolean;
  /** This sheet pressed Dismiss and has not been refused or undone since: a dismissal that then appears is its own. */
  submitted: boolean;
}

export const newDraft = (finding: Finding, reviewId: string): SheetDraft => ({ finding, reviewId, reason: null, text: '', typed: false, submitted: false });

/** The review on screen under the sheet: the finished review or the kept one while the service is away. */
export interface SheetView {
  pr: PrSummary;
  latest: LatestReply;
  offline: boolean;
  notice?: string | undefined;
  busy?: boolean | undefined;
}

export const OFFLINE_KEPT = 'Airlock could not reach its service. Your line is kept.';
export const ALREADY_DISMISSED = 'This finding was already dismissed, so this line cannot be saved to it.';
export const NOT_THIS_REVIEW = 'This review is no longer the one on screen, so this line cannot be saved to it.';

/** One request to the service and what came back: `reply` is the state's notice once it is an answer to this request. */
function useRequest(notice: string | undefined, busy: boolean) {
  const [phase, setPhase] = useState<'no' | 'sent' | 'busy'>('no');
  const before = useRef<string | undefined>(undefined);
  useEffect(() => { if (busy) setPhase((was) => (was === 'sent' ? 'busy' : was)); }, [busy]);
  const reply = phase !== 'no' && notice !== undefined && (notice !== before.current || (phase === 'busy' && !busy)) ? notice : null;
  return {
    reply,
    begin: (): void => { before.current = notice; setPhase('sent'); },
    reset: (): void => setPhase('no'),
  };
}

/** Dismissing one finding: a reason, for Wrong and Intended the exact line saved to the pack, then the result with Undo. */
export function DismissSheet({ draft, onDraft, view, dispatch, active, onClose }: {
  draft: SheetDraft;
  onDraft: (next: SheetDraft) => void;
  view: SheetView;
  dispatch: (action: UserAction) => void;
  /** False while the sheet is kept out of sight. */
  active: boolean;
  /** Cancel or Done: the draft is dropped. */
  onClose: () => void;
}) {
  const { pr, latest, offline } = view;
  const { finding, reason, text } = draft;
  const doc = latest.document;
  const titleId = useId();
  const groupId = useId();
  const fieldId = useId();
  const errorId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const announce = useAnnounce();
  const busy = view.busy === true;
  const save = useRequest(view.notice, busy);
  const undo = useRequest(view.notice, busy);

  const current = doc.id === draft.reviewId && doc.findings.some((f) => f.id === finding.id);
  const dismissal = current ? dismissalOf(finding, latest.dismissals) : undefined;
  // A dismissal is this sheet's own only when the sheet submitted and it then appeared.
  const saved = draft.submitted ? dismissal : undefined;
  const foreign = dismissal !== undefined && !draft.submitted;
  const result = saved === undefined ? null
    : saved.learned === null ? 'Hidden on this pull request.'
      : `Saved to ${pr.packs.find((p) => p.id === saved.learned?.packId)?.title ?? saved.learned.packId}.`;
  useEffect(() => { if (result !== null) announce(result); }, [announce, result]);

  const showing = !current ? 'stale' : foreign ? 'dismissed' : result === null ? 'form' : 'result';
  useEffect(() => { if (offline) announce(OFFLINE_KEPT); }, [announce, offline]);

  // Pressing Dismiss is only this sheet's own until it is refused, undone or lost with the service: a save whose answer
  // never came cannot claim a dismissal that appears later.
  const wasResult = useRef(showing === 'result');
  useEffect(() => {
    const undone = wasResult.current && showing === 'form';
    wasResult.current = showing === 'result';
    const refused = draft.submitted && dismissal === undefined && save.reply !== null;
    const lost = draft.submitted && dismissal === undefined && offline;
    if (draft.submitted && (undone || refused || lost)) onDraft({ ...draft, submitted: false });
  }, [showing, draft, dismissal, save.reply, offline, onDraft]);

  // The control that had focus is gone when the sheet changes between its form and its result; focus goes to its heading.
  // Out of sight the move waits and is not used up.
  const was = useRef(showing);
  useEffect(() => {
    if (!active || was.current === showing) return;
    was.current = showing;
    heading.current?.focus();
  }, [showing, active]);

  const saves = reason !== null && reason !== 'not-now';
  const problem = saves ? checkLearnedText(text, reason) : null;
  // Closing is for when the person can see how the request ended.
  const close = (): void => { if (!busy) onClose(); };

  const choose = (next: DismissReason): void => {
    save.reset();
    undo.reset();
    // The draft is only for a person who has not typed yet.
    onDraft({ ...draft, reason: next, ...(draft.typed ? {} : { text: draftFor(next, finding) }) });
  };
  const edit = (value: string): void => {
    save.reset();
    undo.reset();
    onDraft({ ...draft, text: oneLine(value), typed: true });
  };
  const submit = (): void => {
    if (reason === null) return;
    undo.reset();
    save.begin();
    if (!draft.submitted) onDraft({ ...draft, submitted: true });
    dispatch({
      type: 'dismiss',
      body: { repo: pr.repo, number: pr.number, reviewId: draft.reviewId, findingId: finding.id, reason, text: saves ? text : '' },
    });
  };
  const restore = (): void => {
    save.reset();
    undo.begin();
    // The fingerprint the dismissal was recorded under, which can be one of the finding's aliases.
    dispatch({ type: 'restore', fingerprint: saved?.fingerprint ?? finding.fingerprint });
  };

  const header = (
    <>
      <h2 className="ap-sheet-title" id={titleId} tabIndex={-1} ref={heading}>Dismiss this finding</h2>
      <p className="muted">{shortTitle(finding)}</p>
    </>
  );
  const shell = (children: React.ReactNode) => (
    <Sheet labelledBy={titleId} initialFocus={heading} returnFocus={false} active={active} bottom onClose={close}>
      <div className="ap-sheet">
        {header}
        {children}
      </div>
    </Sheet>
  );

  if (showing === 'stale' || showing === 'dismissed') {
    return shell(
      <>
        <p role="alert" className="notice">{showing === 'stale' ? NOT_THIS_REVIEW : ALREADY_DISMISSED}</p>
        {text !== '' && <pre className="quote">{text}</pre>}
        <div className="actions">
          <CopyButton text={() => text} label="Copy line" />
          {showing === 'stale' && <button type="button" className="btn primary" disabled>Dismiss</button>}
          <button type="button" className="btn" onClick={onClose}>Close</button>
        </div>
      </>,
    );
  }

  if (result !== null) {
    return shell(
      <>
        <p>{result}</p>
        {undo.reply !== null && <p role="alert" className="notice">{undo.reply}</p>}
        <div className="actions">
          <button type="button" className="btn" disabled={busy || offline} onClick={restore}>Undo</button>
          <button type="button" className="btn primary" disabled={busy} onClick={onClose}>Done</button>
        </div>
        {offline && <p className="notice">{OFFLINE_KEPT}</p>}
      </>,
    );
  }

  return shell(
    <>
      <p>{DISMISS_LEAD}</p>
      <div className="ap-group" role="radiogroup" aria-labelledby={groupId}>
        <p className="label" id={groupId}>Why?</p>
        <div className="ap-opts">
          {REASONS.map((r) => (
            <div key={r.reason} className="ap-opt">
              <input
                type="radio" id={`${groupId}-${r.reason}`} name={groupId} checked={reason === r.reason}
                aria-describedby={`${groupId}-${r.reason}-line`} onChange={() => choose(r.reason)}
              />
              <div>
                <label htmlFor={`${groupId}-${r.reason}`}><strong>{r.name}</strong></label>
                <span className="muted block" id={`${groupId}-${r.reason}-line`}>{r.line}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
      {saves && (
        <div className="ap-field">
          <label htmlFor={fieldId} className="label">{LINE_LABEL}</label>
          <textarea
            id={fieldId} className="input" rows={3} value={text} spellCheck={false}
            {...(reason === 'intended' ? { placeholder: INTENDED_PLACEHOLDER } : {})}
            {...(problem === null ? {} : { 'aria-describedby': errorId, 'aria-invalid': true })}
            onChange={(e) => edit(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault(); }}
          />
          <p className="muted">{`${[...text].length} of ${LEARNED_TEXT_MAX}`}</p>
          {problem !== null && <p id={errorId} className="detail">{problem}</p>}
          <p className="muted">{INSTRUCTION_NOTE}</p>
        </div>
      )}
      {save.reply !== null && <p role="alert" className="notice">{save.reply}</p>}
      {undo.reply !== null && <p role="status" className="muted">{undo.reply}</p>}
      {offline && <p className="notice">{OFFLINE_KEPT}</p>}
      <div className="ap-row-buttons">
        <button type="button" className="btn" disabled={busy} onClick={onClose}>Cancel</button>
        <button type="button" className="btn primary" disabled={reason === null || problem !== null || busy || offline} onClick={submit}>Dismiss</button>
      </div>
    </>,
  );
}

/** Where focus goes after the sheet is closed over a finding: the finding's own Dismiss button, else its card or the next one, else a heading. */
export function focusAfterClose(finding: Finding, view: Pick<SheetView, 'latest'> | null): HTMLElement | null {
  const find = (attr: string, id: string): HTMLElement | null =>
    [...document.querySelectorAll<HTMLElement>(`[${attr}]`)].find((n) => n.getAttribute(attr) === id) ?? null;
  const button = find('data-dismiss-for', finding.id);
  if (button !== null && !button.hasAttribute('disabled')) return button;
  const card = (id: string | undefined): HTMLElement | null => (id === undefined ? null : find('data-finding-id', id));
  if (view !== null) {
    const { document: doc, dismissals } = view.latest;
    if (listFindings(doc.findings, dismissals).order.some((f) => f.id === finding.id)) {
      const own = card(finding.id);
      if (own !== null) return own;
    } else {
      const own = dismissalOf(finding, dismissals);
      const all = listFindings(doc.findings, dismissals.filter((d) => d !== own)).order;
      const at = all.findIndex((f) => f.id === finding.id);
      for (const f of at === -1 ? [] : [all[at + 1], all[at - 1]]) { const found = card(f?.id); if (found !== null) return found; }
    }
  }
  return document.querySelector<HTMLElement>('[data-focus="findings"]') ?? document.querySelector<HTMLElement>('[data-focus="verdict"]');
}
