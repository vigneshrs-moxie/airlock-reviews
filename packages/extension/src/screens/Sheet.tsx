import { useEffect, useRef, type ReactNode, type RefObject } from 'react';

const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), textarea:not(:disabled)';

/**
 * A dialog over the panel: it has a role and a label, closes on Escape or a click on the backdrop, takes focus when it
 * opens, keeps focus inside while open and gives focus back to what had it before. The content is the children.
 */
export function Sheet({ labelledBy, initialFocus, returnFocusTo, fallbackFocus, active = true, onClose, children }: {
  /** The id of the heading that names the dialog. */
  labelledBy: string;
  /** What takes focus when the sheet opens. */
  initialFocus: RefObject<HTMLElement | null>;
  /** Where focus goes on close, when the control that opened the sheet is not the one that had focus. */
  returnFocusTo?: RefObject<HTMLElement | null>;
  /** Where focus goes on close when the opener is gone; read when the sheet closes. */
  fallbackFocus?: () => HTMLElement | null;
  /** False while the sheet is kept out of sight (hidden): it then neither traps focus nor reacts to keys. */
  active?: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const sheet = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const fallback = useRef(fallbackFocus);
  fallback.current = fallbackFocus;

  useEffect(() => {
    const was = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    initialFocus.current?.focus();
    return () => {
      const opener = returnFocusTo?.current ?? was;
      // Back to the opener; when it is gone (a dismissed finding's button), to where the panel says, or its content.
      if (opener?.isConnected === true && !opener.hasAttribute('disabled')) opener.focus();
      else (fallback.current?.() ?? document.querySelector<HTMLElement>('main'))?.focus();
    };
  }, [initialFocus, returnFocusTo]);

  useEffect(() => {
    if (!active) return undefined;
    const inside = (node: EventTarget | null): boolean => node instanceof Node && sheet.current?.contains(node) === true;
    const first = (): HTMLElement | null | undefined => sheet.current?.querySelector<HTMLElement>(FOCUSABLE);
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close.current();
      // A Tab pressed while focus is on the page behind (or nowhere) goes into the sheet.
      else if (event.key === 'Tab' && !inside(document.activeElement)) { event.preventDefault(); first()?.focus(); }
    };
    // Focus never rests outside the sheet while it is open.
    const onFocusIn = (event: FocusEvent): void => { if (!inside(event.target)) first()?.focus(); };
    document.addEventListener('keydown', onKey);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('focusin', onFocusIn);
    };
  }, [active]);

  // Tab and Shift+Tab go round the sheet's controls and never leave it.
  const trap = (event: React.KeyboardEvent): void => {
    if (event.key !== 'Tab') return;
    const controls = [...(sheet.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
    const last = controls.length - 1;
    const at = controls.indexOf(document.activeElement as HTMLElement);
    if (last < 0) return;
    if (event.shiftKey && at <= 0) { event.preventDefault(); controls[last]?.focus(); }
    else if (!event.shiftKey && at === last) { event.preventDefault(); controls[0]?.focus(); }
  };

  return (
    <div className="sheet" onClick={(event) => { if (event.target === event.currentTarget) close.current(); }}>
      <div className="sheet-body" role="dialog" aria-modal="true" aria-labelledby={labelledBy} ref={sheet} onKeyDown={trap}>
        {children}
      </div>
    </div>
  );
}
