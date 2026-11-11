import { useId, type ReactNode } from 'react';

/** A section whose heading is a button that shows or hides its content; its state is kept by the caller. */
export function Collapsible({ title, open, onToggle, children }: { title: string; open: boolean; onToggle: () => void; children: ReactNode }) {
  const id = useId();
  return (
    <section className="card">
      <h2 className="label">
        <button type="button" className="fold" aria-expanded={open} aria-controls={id} onClick={onToggle}>{title}</button>
      </h2>
      {open && <div id={id}>{children}</div>}
    </section>
  );
}
