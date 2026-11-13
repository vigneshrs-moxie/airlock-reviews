import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useVisible } from './visible';

/** Each bar's last measured height, so a bar drawn again (back from a finding) leaves its room from the first paint. */
const lastRoom = new Map<string, number>();

/**
 * A bar pinned to the bottom of the panel, as wide as the panel, with a space as tall as it at the end of the screen's
 * content, so nothing scrolls out of reach under it. The review's bar and a finding's actions are both this.
 *
 * Its height is measured (its buttons wrap at narrow widths and large sizes) in the panel's own CSS pixels
 * (`offsetHeight`, which the size setting's zoom does not scale), and is also kept on the root as `--ap-pinned-height`,
 * so a control reached with Tab is scrolled clear of the bar (shared.css). While the screen is kept out of sight (Settings
 * open) the bar is not drawn: its last height is kept, and it is measured again when the screen comes back.
 *
 * `above`, when given, sits over the buttons inside the bar and scrolls on its own when the bar would be taller than its
 * share of the panel; the buttons stay.
 */
export function Pinned({ name, label, above, children }: {
  /** Which bar: its last height is remembered under this name. */
  name: string;
  /** The buttons' group name, for screen readers. */
  label: string;
  above?: ReactNode;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState(() => lastRoom.get(name) ?? 0);
  const visible = useVisible();
  useLayoutEffect(() => {
    const node = box.current;
    if (node === null || !visible) return undefined;
    const root = document.documentElement;
    const measure = (): void => {
      // Not drawn (a hidden ancestor): keep the last height rather than leave no room.
      if (node.getClientRects().length === 0) return;
      const height = node.offsetHeight;
      lastRoom.set(name, height);
      setRoom(height);
      root.style.setProperty('--ap-pinned-height', `${height}px`);
    };
    measure();
    const watch = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    watch?.observe(node);
    return () => {
      watch?.disconnect();
      root.style.removeProperty('--ap-pinned-height');
    };
  }, [name, visible]);
  return (
    <>
      <div className="ap-pinned-room" style={{ height: room }} aria-hidden="true" />
      <div className={`ap-pinned ap-pinned-${name}`} ref={box}>
        {above !== undefined && above !== null && above !== false && <div className="ap-pinned-above">{above}</div>}
        <div className="ap-bar" role="group" aria-label={label}>{children}</div>
      </div>
    </>
  );
}
