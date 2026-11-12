import type { Finding, PostRecord } from '@airlock/shared';
import { PostedMark } from './PostedMark';
import { locationText, severityWord } from './words';

/** The findings that held up but did not make the top list, one line each. */
export function AlsoFound({ findings, onOpen, register, postOf = () => undefined }: {
  findings: readonly Finding[];
  /** A finding's post record, when it is posted or its post's outcome is not known. */
  postOf?: (finding: Finding) => PostRecord | undefined;
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
              <span className="title">{f.title}</span>
              <code className="path">{locationText(f)}</code>
              {posted !== undefined && <PostedMark record={posted} link={false} />}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
