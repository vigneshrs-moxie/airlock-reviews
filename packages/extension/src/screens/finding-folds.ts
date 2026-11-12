import { useState } from 'react';

/** The folds of the finding screen. */
export type FindingFold = 'happens' | 'why' | 'code' | 'involves' | 'proof';

/**
 * Which folds are open, for the panel page's life: the finding screen is remounted for every finding, and the person
 * who opened The code on one finding finds it open on the next one, and on this one again when they come back.
 */
let remembered: ReadonlySet<FindingFold> = new Set();

/** The open folds, starting from the remembered ones, and a toggle that remembers its change. */
export function useFindingFolds(): [ReadonlySet<FindingFold>, (fold: FindingFold) => void] {
  const [open, setOpen] = useState(remembered);
  const toggle = (fold: FindingFold): void => {
    const next = new Set(open);
    if (next.has(fold)) next.delete(fold);
    else next.add(fold);
    remembered = next;
    setOpen(next);
  };
  return [open, toggle];
}

/** Closes every fold for the next finding screen; for tests, which share the panel page's module. */
export function forgetFindingFolds(): void {
  remembered = new Set();
}
