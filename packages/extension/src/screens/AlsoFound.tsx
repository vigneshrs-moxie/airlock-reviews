import { STATUS_WORD, type Finding, type PostRecord } from '@airlock/shared';
import type { ReactNode } from 'react';
import { PostedMark } from './PostedMark';
import { locationText, severityWord } from './words';

/** The findings that held up but did not make the top list, one line each. */
export function AlsoFound({ findings, onOpen, register, postOf = () => undefined, after = () => null }: {
  findings: readonly Finding[];
  /** A finding's post record, when it is posted or its post's outcome is not known. */
  postOf?: (finding: Finding) => PostRecord | undefined;
  /** What goes under a line's button, outside it (a mark with its own controls). */
  after?: (finding: Finding) => ReactNode;
  onOpen: (finding: Finding) => void;
  register: (id: string, node: HTMLButtonElement | null) => void;
}) {
  return (
    <ul className="plain">
      {findings.map((f) => {
        const posted = postOf(f);
        return (
          <li key={f.id}>
            <button type="button" className="line" onClick={() => onOpen(f)} ref={(node) => register(f.id, node)}>
              <span className="sev">{severityWord(f.severity)}</span>
              {f.status !== null && <span className="status" data-testid="status">{STATUS_WORD[f.status]}</span>}
              <span className="title">{f.title}</span>
              <code className="path">{locationText(f)}</code>
              {posted !== undefined && posted.outcome === 'posted' && <PostedMark record={posted} link={false} />}
            </button>
            {after(f)}
          </li>
        );
      })}
    </ul>
  );
}
