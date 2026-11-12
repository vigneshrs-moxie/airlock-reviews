import type { Finding } from '@airlock/shared';
import { locationText } from './words';

/** Findings of an earlier review that a re-review found fixed: title, place and why they count as fixed. Nothing to tick, post or dismiss. */
export function FixedList({ findings }: { findings: readonly Finding[] }) {
  return (
    <ul className="plain">
      {findings.map((f) => (
        <li key={f.id}>
          <div className="title">{f.title}</div>
          <code className="path">{locationText(f)}</code>
          <div className="muted">{f.checked}</div>
        </li>
      ))}
    </ul>
  );
}
