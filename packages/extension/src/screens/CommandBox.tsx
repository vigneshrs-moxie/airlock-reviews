import { useEffect, useId, useRef, useState } from 'react';
import { realTimers, type Timers } from '../client/timers';
import { useAnnounce } from './Frame';

export const COPIED_MS = 2_000;

/** A command to copy: an intro line, the command in a box, and a Copy button. When copying is refused the text is selected for copying by hand. */
export function CommandBox({ intro, command, timers = realTimers }: { intro: string; command: string; timers?: Timers }) {
  const box = useRef<HTMLElement>(null);
  const reset = useRef<unknown>(null);
  const [copied, setCopied] = useState(false);
  const announce = useAnnounce();
  const labelId = useId();

  useEffect(() => () => { if (reset.current !== null) timers.clearTimeout(reset.current); }, [timers]);

  const select = (): void => {
    const node = box.current;
    const selection = window.getSelection();
    if (!node || !selection) return;
    const range = document.createRange();
    range.selectNodeContents(node);
    selection.removeAllRanges();
    selection.addRange(range);
  };
  const done = (): void => {
    setCopied(true);
    announce('Copied');
    if (reset.current !== null) timers.clearTimeout(reset.current);
    reset.current = timers.setTimeout(() => { reset.current = null; setCopied(false); }, COPIED_MS);
  };
  const copy = (): void => {
    try {
      navigator.clipboard.writeText(command).then(done, () => { setCopied(false); select(); });
    } catch {
      select();
    }
  };

  return (
    <div role="group" aria-labelledby={labelId}>
      <p id={labelId}>{intro}</p>
      <div className="command">
        <code className="code" ref={box} tabIndex={0}>{command}</code>
        <button type="button" className="btn small" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
      </div>
    </div>
  );
}
