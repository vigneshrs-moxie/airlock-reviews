import type { Finding, PostRecord } from '@airlock/shared';
import type { ReactNode } from 'react';
import { FindingCard } from './FindingCard';

/** The findings that held up but did not make the top list, one row each, as the top list's rows. */
export function AlsoFound({ findings, showStatus, selecting, selected, onToggle, onOpen, register, postOf = () => undefined, after = () => null }: {
  findings: readonly Finding[];
  showStatus: boolean;
  selecting: boolean;
  selected: ReadonlySet<string>;
  onToggle: (finding: Finding) => void;
  /** A finding's post record, when it is posted or its post's outcome is not known. */
  postOf?: (finding: Finding) => PostRecord | undefined;
  /** What goes under a row's button, outside it (a mark with its own controls). */
  after?: (finding: Finding) => ReactNode;
  onOpen: (finding: Finding) => void;
  register: (id: string, node: HTMLButtonElement | null) => void;
}) {
  return (
    <ul className="plain ap-list">
      {findings.map((f) => (
        <FindingCard
          key={f.id} finding={f} showStatus={showStatus} selecting={selecting} selected={selected.has(f.id)} onToggle={() => onToggle(f)}
          onOpen={() => onOpen(f)} register={register} posted={postOf(f)} after={after(f)}
        />
      ))}
    </ul>
  );
}
