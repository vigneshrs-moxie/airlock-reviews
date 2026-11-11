/** GitHub names a file's section in the Files changed page `diff-` plus the SHA-256 of its path. */
export async function diffAnchorId(path: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(path));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `diff-${hex}`;
}

export function filesUrl(repo: string, number: number, anchorId?: string, line?: number): string {
  const base = `https://github.com/${repo}/pull/${number}/files`;
  if (anchorId === undefined) return base;
  return `${base}#${anchorId}${line === undefined ? '' : `R${line}`}`;
}

export function blobUrl(repo: string, sha: string, path: string, line?: number | null): string {
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  const base = `https://github.com/${repo}/blob/${sha}/${encoded}`;
  return line === undefined || line === null ? base : `${base}#L${line}`;
}
