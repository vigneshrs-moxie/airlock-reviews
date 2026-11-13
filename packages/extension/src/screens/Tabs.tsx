import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';

export interface TabItem<K extends string> {
  key: K;
  label: string;
  /** Set on the tab so the review's focus helpers can find it (`data-focus`). */
  focusName?: string;
}

/**
 * A row of tabs over one panel: real buttons with `role="tab"`, the chosen one `aria-selected`. Left and Right move to the
 * next tab and choose it, wrapping at the ends; Home and End go to the first and last. Only the chosen tab is in the Tab
 * order, and only its panel is drawn. The panel, named by its tab, is in the Tab order too, as it may start with no
 * control (The change opens on a sentence). The choice is kept by the caller.
 */
export function Tabs<K extends string>({ label, items, chosen, onChoose, children }: {
  label: string;
  items: readonly TabItem<K>[];
  chosen: K;
  onChoose: (key: K) => void;
  children: ReactNode;
}) {
  const base = useId();
  const nodes = useRef(new Map<K, HTMLButtonElement>());
  const tabId = (key: K): string => `${base}-tab-${key}`;
  const panelId = `${base}-panel`;
  const move = (event: KeyboardEvent<HTMLButtonElement>, at: number): void => {
    const last = items.length - 1;
    const to = event.key === 'ArrowRight' ? (at === last ? 0 : at + 1)
      : event.key === 'ArrowLeft' ? (at === 0 ? last : at - 1)
        : event.key === 'Home' ? 0 : event.key === 'End' ? last : null;
    if (to === null) return;
    event.preventDefault();
    const key = items[to]!.key;
    onChoose(key);
    nodes.current.get(key)?.focus();
  };
  return (
    <>
      <div role="tablist" aria-label={label} className="ap-tabs">
        {items.map((item, i) => {
          const on = item.key === chosen;
          return (
            <button
              key={item.key} type="button" role="tab" id={tabId(item.key)} className={on ? 'ap-tab on' : 'ap-tab'}
              aria-selected={on} tabIndex={on ? 0 : -1} {...(on ? { 'aria-controls': panelId } : {})}
              {...(item.focusName === undefined ? {} : { 'data-focus': item.focusName })}
              ref={(node) => { if (node === null) nodes.current.delete(item.key); else nodes.current.set(item.key, node); }}
              onClick={() => onChoose(item.key)} onKeyDown={(event) => move(event, i)}
            >
              {item.label}
            </button>
          );
        })}
      </div>
      <div role="tabpanel" id={panelId} aria-labelledby={tabId(chosen)} tabIndex={0} className="ap-group ap-panel">
        {children}
      </div>
    </>
  );
}
