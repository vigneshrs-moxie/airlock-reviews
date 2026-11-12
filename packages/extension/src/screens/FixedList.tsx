import type { Finding } from '@airlock/shared';
import { locationText } from './words';

/**
 * Findings of an earlier review that a re-review found fixed, one row each: the word Fixed, the title, how it was
 * confirmed, and the place. Nothing to open, tick, post or dismiss, so the title is shown whole.
 */
export function FixedList({ findings }: { findings: readonly Finding[] }) {
  return (
    <ul className="plain ap-list">
      {findings.map((f) => (
        <li key={f.id} className="ap-item">
          <div className="ap-row still">
            <span className="ap-sev sev-ok">Fixed</span>
            <div className="ap-row-main">
              <span className="title ap-row-title whole">{f.title}</span>
              <span className="muted">{f.checked}</span>
              <span className="ap-row-sub"><code className="path">{locationText(f)}</code></span>
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}
