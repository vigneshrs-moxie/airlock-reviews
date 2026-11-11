import { createHash } from 'node:crypto';
import type { Candidate } from '@airlock/shared';

/** A stable id for a finding: survives re-indenting, changes with the rule (or lens), the file or the quoted code. */
export function fingerprint(c: Pick<Candidate, 'source' | 'path' | 'quote'>): string {
  const origin = c.source.ruleId ?? c.source.lens ?? '';
  const text = `${origin}\n${c.path}\n${c.quote.replace(/\s+/g, '')}`;
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}
