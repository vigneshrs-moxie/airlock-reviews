import { useId, type ReactNode } from 'react';

/**
 * A fold: a heading whose button shows or hides what is under it, with its count said in words beside the title (`count`,
 * left out when there is none). Its state is kept by the caller.
 */
export function Collapsible({ title, count, open, onToggle, children }: {
  title: string; count?: string; open: boolean; onToggle: () => void; children: ReactNode;
}) {
  const id = useId();
  return (
    <section className="ap-fold-section">
      <h3 className="ap-fold-heading">
        <button type="button" className="ap-fold" aria-expanded={open} {...(open ? { 'aria-controls': id } : {})} onClick={onToggle}>
          <span aria-hidden="true" className="ap-arrow" />
          <span className="ap-fold-title">{title}</span>
          {count !== undefined && <>{' '}<span className="n">{count}</span></>}
        </button>
      </h3>
      {open && <div className="ap-folded" id={id}>{children}</div>}
    </section>
  );
}
