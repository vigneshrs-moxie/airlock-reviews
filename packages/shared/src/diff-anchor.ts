import { isRepo } from './api.js';

const ANCHOR_PATTERN = /^diff-[0-9a-f]{64}$/;
const SHA_PATTERN = /^[0-9a-fA-F]{7,64}$/;

const isLine = (line: number | null | undefined): line is number =>
  typeof line === 'number' && Number.isSafeInteger(line) && line > 0;

/**
 * GitHub names a file's section in the Files changed page `diff-` plus the SHA-256 of its path.
 * A path with a lone surrogate is hashed in its well-formed form (replacement character), so this never throws.
 */
export async function diffAnchorId(path: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(path.toWellFormed()));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `diff-${hex}`;
}

/** The Files changed page, or null when the repository, number or anchor is not valid. */
export function filesUrl(repo: string, number: number, anchorId?: string, line?: number): string | null {
  if (!isRepo(repo) || !Number.isSafeInteger(number) || number <= 0) return null;
  const base = `https://github.com/${repo}/pull/${number}/files`;
  if (anchorId === undefined) return base;
  if (!ANCHOR_PATTERN.test(anchorId)) return null;
  return `${base}#${anchorId}${isLine(line) ? `R${line}` : ''}`;
}

/** A file at a commit, or null when the repository, commit or path is not valid. */
export function blobUrl(repo: string, sha: string, path: string, line?: number | null): string | null {
  if (!isRepo(repo) || !SHA_PATTERN.test(sha)) return null;
  if (path === '' || path.startsWith('/') || path.includes('\\') || path.includes('\0') || !path.isWellFormed()) return null;
  const segments = path.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return null;
  const base = `https://github.com/${repo}/blob/${sha}/${segments.map(encodeURIComponent).join('/')}`;
  return isLine(line) ? `${base}#L${line}` : base;
}
