import { useRef, useState } from 'react';

/** A command to copy: shown in a box with a Copy button; when copying is refused the text is selected for copying by hand. */
export function CommandBox({ command, label }: { command: string; label: string }) {
  const box = useRef<HTMLElement>(null);
  const [copied, setCopied] = useState(false);

  const copy = (): void => {
    const select = (): void => {
      const node = box.current;
      const selection = window.getSelection();
      if (!node || !selection) return;
      const range = document.createRange();
      range.selectNodeContents(node);
      selection.removeAllRanges();
      selection.addRange(range);
    };
    try {
      navigator.clipboard.writeText(command).then(() => setCopied(true), () => { setCopied(false); select(); });
    } catch {
      select();
    }
  };

  return (
    <div className="command">
      <code className="code" ref={box} aria-label={label} tabIndex={0}>{command}</code>
      <button type="button" className="btn small" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
    </div>
  );
}
