import type { Finding } from '@airlock/shared';
import { locationText, severityWord } from './words';

/** The findings that held up but did not make the top list, one line each. */
export function AlsoFound({ findings, onOpen, register }: {
  findings: readonly Finding[];
  onOpen: (finding: Finding) => void;
  register: (id: string, node: HTMLButtonElement | null) => void;
}) {
  return (
    <ul className="plain">
      {findings.map((f) => (
        <li key={f.id}>
          <button type="button" className="line" onClick={() => onOpen(f)} ref={(node) => register(f.id, node)}>
            <span className="sev">{severityWord(f.severity)}</span>
            <span className="title">{f.title}</span>
            <code className="path">{locationText(f)}</code>
          </button>
        </li>
      ))}
    </ul>
  );
}
