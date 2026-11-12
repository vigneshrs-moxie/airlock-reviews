import { useEffect, useRef, useState } from 'react';
import { realTimers, type Timers } from '../client/timers';
import { COPIED_MS } from './CommandBox';
import { useAnnounce } from './Frame';

/**
 * A button that copies `text()` (read when it is pressed). It says Copied for two seconds. When copying is refused, or there is
 * no clipboard, the text is shown in a box with the text selected, to copy by hand.
 */
export function CopyButton({ text, label, timers = realTimers }: { text: () => string; label: string; timers?: Timers }) {
  const box = useRef<HTMLPreElement>(null);
  const reset = useRef<unknown>(null);
  const [copied, setCopied] = useState(false);
  const [shown, setShown] = useState<string | null>(null);
  const announce = useAnnounce();

  // A copy answered after the screen is gone starts no timer.
  const gone = useRef(false);
  useEffect(() => {
    gone.current = false;
    return () => {
      gone.current = true;
      if (reset.current !== null) timers.clearTimeout(reset.current);
      reset.current = null;
    };
  }, [timers]);
  useEffect(() => {
    const node = box.current;
    const selection = window.getSelection();
    if (shown === null || !node || !selection) return;
    const range = document.createRange();
    range.selectNodeContents(node);
    selection.removeAllRanges();
    selection.addRange(range);
  }, [shown]);

  const done = (): void => {
    if (gone.current) return;
    setShown(null);
    setCopied(true);
    announce('Copied');
    if (reset.current !== null) timers.clearTimeout(reset.current);
    reset.current = timers.setTimeout(() => { reset.current = null; setCopied(false); }, COPIED_MS);
  };
  const refused = (value: string): void => { setCopied(false); setShown(value); };
  const copy = (): void => {
    const value = text();
    try {
      navigator.clipboard.writeText(value).then(done, () => refused(value));
    } catch {
      refused(value);
    }
  };

  return (
    <>
      <button type="button" className="btn small" onClick={copy}>{copied ? 'Copied' : label}</button>
      {shown !== null && (
        <div className="block">
          <p className="muted">Copying was refused. Select this text and copy it yourself.</p>
          <pre className="quote" ref={box} tabIndex={0}>{shown}</pre>
        </div>
      )}
    </>
  );
}
