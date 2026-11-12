import { useEffect, useId, useRef, type ReactNode, type RefObject } from 'react';
import type { PanelState } from '../state/reduce';
import { useAnnounce } from './Frame';
import { Sheet } from './Sheet';

export type TourStep = 1 | 2 | 3;

export const TOUR_TITLES: Record<TourStep, string> = {
  1: 'Start at the top',
  2: 'Three things you can do with a finding',
  3: 'Notes and size',
};

/** Whether the tour may open by itself: never seen, a finished review on screen, and nothing else over the panel. */
export function tourMayOpen(state: PanelState, { seen, ended, sheetOpen, settingsOpen }: {
  /** From the store; null until it is read. */
  seen: boolean | null;
  /** The person ended the tour while this panel was open. */
  ended: boolean;
  /** A dismiss or post sheet is open. */
  sheetOpen: boolean;
  settingsOpen: boolean;
}): boolean {
  return seen === false && !ended && state.kind === 'review' && !sheetOpen && !settingsOpen;
}

const Icon = ({ children }: { children: ReactNode }) => (
  <svg
    className="icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"
  >
    {children}
  </svg>
);
const CopyIcon = () => (
  <Icon><rect width="14" height="14" x="8" y="8" rx="2" ry="2" /><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" /></Icon>
);
const CommentIcon = () => <Icon><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></Icon>;
const HideIcon = () => (
  <Icon>
    <path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49" />
    <path d="M14.084 14.158a3 3 0 0 1-4.242-4.242" />
    <path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143" />
    <path d="m2 2 20 20" />
  </Icon>
);

/** What each step says under its title. */
function StepBody({ step }: { step: TourStep }) {
  if (step === 1) {
    return (
      <>
        <p>The verdict says whether this can merge. Under it, each finding is one line. Tap a line for the short version; the detail is folded below it.</p>
        {/* A picture of the top of a review; the sentence above says it, so it is hidden from screen readers. */}
        <div className="ap-preview" aria-hidden="true">
          <div className="ap-chips">
            <span className="ap-chip sev-fix">1 to fix</span>
            <span className="ap-chip sev-ask">3 questions</span>
          </div>
          <div className="ap-row">
            <span className="ap-sev sev-fix">Fix</span>
            <span className="ap-row-main"><span className="ap-row-title">Tests pass without testing the safety rules</span></span>
          </div>
        </div>
      </>
    );
  }
  if (step === 2) {
    return (
      <div className="tour-actions">
        <div className="ap-where"><CopyIcon /><p><b>Copy fix prompt</b> copies instructions for your coding agent.</p></div>
        <div className="ap-where">
          <CommentIcon />
          <p><b>Comment on GitHub</b> shows you the exact text and where it goes: on the line, or in the review summary. It posts only when you press Post.</p>
        </div>
        <div className="ap-where"><HideIcon /><p><b>Dismiss</b> hides the finding here and teaches Airlock. Nothing goes to GitHub.</p></div>
      </div>
    );
  }
  return (
    <p>Open findings also appear as private notes under their lines on GitHub&apos;s Files changed page. Settings changes the text and button size, and shows this tour again.</p>
  );
}

/**
 * The three-step tour, in a sheet that rises from the bottom over whatever is on screen. Skip, Done, Escape and a click
 * on the backdrop end it (`onEnd`); Next moves on (`onStep`). It traps focus while open and gives it back on close.
 */
export function Tour({ step, onStep, onEnd, returnFocusTo }: {
  step: TourStep;
  onStep: (step: TourStep) => void;
  onEnd: () => void;
  /** Where focus goes on close, when the control that opened the tour is gone (Show the tour again in Settings). */
  returnFocusTo?: RefObject<HTMLElement | null>;
}) {
  const titleId = useId();
  const primary = useRef<HTMLButtonElement>(null);
  const announce = useAnnounce();
  const first = useRef(true);
  // The primary button keeps focus from step to step, so the new step is said.
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    announce(`Step ${step} of 3. ${TOUR_TITLES[step]}`);
  }, [step, announce]);
  return (
    <Sheet labelledBy={titleId} initialFocus={primary} bottom onClose={onEnd} {...(returnFocusTo ? { returnFocusTo } : {})}>
      <div className="tour">
        <span className="label">{`Step ${step} of 3`}</span>
        <h2 className="ap-sheet-title" id={titleId}>{TOUR_TITLES[step]}</h2>
        <StepBody step={step} />
        <div className="ap-dots">
          {([1, 2, 3] as const).map((n) => (n === step
            ? <i key={n} className="on"><span className="sr-only">{`This is step ${n} of 3.`}</span></i>
            : <i key={n} aria-hidden="true" />))}
        </div>
        <div className="tour-buttons">
          {step < 3 && <button type="button" className="btn" onClick={onEnd}>Skip</button>}
          <button type="button" className="btn primary" ref={primary} onClick={() => (step < 3 ? onStep((step + 1) as TourStep) : onEnd())}>
            {step < 3 ? 'Next' : 'Done'}
          </button>
        </div>
      </div>
    </Sheet>
  );
}
