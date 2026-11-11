import { checkLearnedText, LEARNED_TEXT_MAX, type DismissReason, type Finding } from '@airlock/shared';
import { useEffect, useId, useRef, useState } from 'react';
import type { PanelState, UserAction } from '../state/reduce';
import { useAnnounce } from './Frame';
import { Sheet } from './Sheet';

export const TITLE_IN_DRAFT_MAX = 120;

const REASONS: { reason: DismissReason; name: string; line: string }[] = [
  { reason: 'wrong', name: 'Wrong', line: 'The finding is mistaken. Saved to your pack so the same mistake is not made again.' },
  { reason: 'intended', name: 'Intended', line: 'The code is right for a reason the reviewer could not know. Saved to your pack as a product fact.' },
  { reason: 'not-now', name: 'Not now', line: 'Hide it on this pull request only. Nothing is saved to your pack.' },
];

export const INTENDED_PLACEHOLDER = 'The product fact the reviewer did not know';
export const INSTRUCTION_NOTE = 'This line is given to the reviewer as an instruction in every later review of this repository. Write it so it is true on its own.';

/** The line the sheet starts from for a reason; built by code, then the person's to edit. */
export function draftFor(reason: DismissReason, finding: Pick<Finding, 'title' | 'path'>): string {
  if (reason !== 'wrong') return '';
  const chars = [...finding.title.replace(/\s+/g, ' ').trim()];
  const title = chars.length <= TITLE_IN_DRAFT_MAX ? chars.join('') : `${chars.slice(0, TITLE_IN_DRAFT_MAX).join('')}…`;
  return `Flagged "${title}" in ${finding.path}. Wrong because: `;
}

/** A line break typed or pasted becomes a space; nothing else is changed. */
const oneLine = (text: string): string => text.replace(/\r\n|[\r\n\u2028\u2029]/g, ' ');

type ReviewState = Extract<PanelState, { kind: 'review' }>;

/** Dismissing one finding: a reason, for Wrong and Intended the exact line saved to the pack, then the result with Undo. */
export function DismissSheet({ state, finding, dispatch, onClose }: {
  state: ReviewState;
  finding: Finding;
  dispatch: (action: UserAction) => void;
  onClose: () => void;
}) {
  const { pr, latest } = state;
  const titleId = useId();
  const groupId = useId();
  const fieldId = useId();
  const errorId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const announce = useAnnounce();
  const [reason, setReason] = useState<DismissReason | null>(null);
  const [text, setText] = useState('');
  const typed = useRef(false);
  const noticeAtOpen = useRef(state.notice);
  // 'sent' once Save is pressed, 'busy' once the state has shown the save in flight.
  const [sent, setSent] = useState<'no' | 'sent' | 'busy'>('no');
  const busy = state.busy === true;

  const saved = latest.dismissals.find((d) => d.fingerprint === finding.fingerprint);
  const result = saved === undefined ? null
    : saved.learned === null ? 'Hidden on this pull request.'
      : `Saved to ${pr.packs.find((p) => p.id === saved.learned?.packId)?.title ?? saved.learned.packId}.`;
  useEffect(() => { if (result !== null) announce(result); }, [announce, result]);
  useEffect(() => { if (busy) setSent((was) => (was === 'sent' ? 'busy' : was)); }, [busy]);
  // The control that had focus is gone when the sheet changes between its form and its result; focus goes to its heading.
  const view = useRef(result === null);
  useEffect(() => {
    if (view.current !== (result === null)) { view.current = result === null; heading.current?.focus(); }
  }, [result]);

  const saves = reason !== null && reason !== 'not-now';
  const problem = saves ? checkLearnedText(text, reason) : null;
  const refused = saved === undefined && state.notice !== undefined && (state.notice !== noticeAtOpen.current || (sent === 'busy' && !busy));

  const choose = (next: DismissReason): void => {
    setReason(next);
    // The draft is only for a person who has not typed yet.
    if (!typed.current) setText(draftFor(next, finding));
  };
  const submit = (): void => {
    if (reason === null) return;
    setSent('sent');
    dispatch({
      type: 'dismiss',
      body: { repo: pr.repo, number: pr.number, reviewId: latest.document.id, findingId: finding.id, reason, text: saves ? text : '' },
    });
  };

  const header = (
    <>
      <h2 className="title" id={titleId} tabIndex={-1} ref={heading}>Dismiss this finding</h2>
      <p className="title">{finding.title}</p>
    </>
  );

  if (result !== null) {
    return (
      <Sheet labelledBy={titleId} initialFocus={heading} onClose={onClose}>
        {header}
        <p>{result}</p>
        <div className="actions">
          <button type="button" className="btn" disabled={busy} onClick={() => { setSent('no'); dispatch({ type: 'restore', fingerprint: finding.fingerprint }); }}>Undo</button>
          <button type="button" className="btn primary" onClick={onClose}>Done</button>
        </div>
      </Sheet>
    );
  }

  return (
    <Sheet labelledBy={titleId} initialFocus={heading} onClose={onClose}>
      {header}
      <div role="radiogroup" aria-labelledby={groupId}>
        <p className="label" id={groupId}>Why are you dismissing it?</p>
        {REASONS.map((r) => (
          <div key={r.reason} className="choice">
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
      {saves && (
        <div className="part">
          <p>{INSTRUCTION_NOTE}</p>
          <label htmlFor={fieldId} className="label">The line that will be saved to your pack</label>
          <textarea
            id={fieldId} className="input" rows={3} value={text} spellCheck={false}
            {...(reason === 'intended' ? { placeholder: INTENDED_PLACEHOLDER } : {})}
            {...(problem === null ? {} : { 'aria-describedby': errorId, 'aria-invalid': true })}
            onChange={(e) => { typed.current = true; setText(oneLine(e.target.value)); }}
          />
          <p className="muted">{`${[...text].length} of ${LEARNED_TEXT_MAX}`}</p>
          {problem !== null && <p id={errorId} className="detail">{problem}</p>}
        </div>
      )}
      {refused && <p role="alert" className="notice">{state.notice}</p>}
      <div className="actions">
        <button type="button" className="btn primary" disabled={reason === null || problem !== null || busy} onClick={submit}>Save</button>
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
      </div>
    </Sheet>
  );
}
