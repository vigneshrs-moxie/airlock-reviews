import type { DiffLine, FileDiff } from '@airlock/shared';

function row(l: DiffLine): string {
  const num = l.newNo === null ? '' : String(l.newNo);
  const marker = l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' ';
  return `${num.padStart(5)} ${marker} ${l.text}`;
}

/** Numbered diff for a model prompt: new-file line numbers on added and context lines. */
export function formatForPrompt(file: FileDiff, opts: { maxLines?: number } = {}): string {
  let title = `## File: ${file.path}`;
  if (file.status === 'renamed' && file.oldPath) title += ` (renamed from ${file.oldPath})`;
  if (file.status === 'deleted') title += ' (deleted)';
  if (file.binary) return `${title} (binary, not shown)`;

  const out = [title];
  const max = opts.maxLines ?? Infinity;
  let shown = 0;
  let hidden = 0;
  for (const h of file.hunks) {
    if (shown >= max) {
      hidden += h.lines.filter((l) => l.kind !== 'ctx').length;
      continue;
    }
    out.push(h.header);
    for (const l of h.lines) {
      if (shown >= max) {
        if (l.kind !== 'ctx') hidden++;
        continue;
      }
      out.push(row(l));
      shown++;
    }
  }
  if (hidden > 0) out.push(`… ${hidden} more changed lines not shown; read the file`);
  return out.join('\n');
}
