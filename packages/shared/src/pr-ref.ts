// Reading a pull request from a GitHub address. No imports: the content script runs this on every github.com page.

const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,98}[A-Za-z0-9])?$/;
const NAME_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;

/** A repository is `<owner>/<name>`; the one rule used for every repo in requests, replies and links. */
export function isRepo(value: string): boolean {
  const parts = value.split('/');
  if (parts.length !== 2) return false;
  const [owner, name] = parts as [string, string];
  return OWNER_PATTERN.test(owner) && NAME_PATTERN.test(name) && !/^\.+$/.test(name) && !/\.git$/i.test(name);
}

export type PrPage = 'conversation' | 'files' | 'commits' | 'checks' | 'other';

function pageOf(rest: string[]): PrPage {
  const [first, ...more] = rest;
  if (first === undefined) return 'conversation';
  if (first === 'files') return more.length === 0 ? 'files' : 'other';
  if (first === 'changes') return 'files';
  if (first === 'commits') return more.length <= 1 ? 'commits' : 'other';
  if (first === 'checks') return more.length === 0 ? 'checks' : 'other';
  return 'other';
}

/** Reads a GitHub pull request page address; null for anything else. Never throws. */
export function prRefFromUrl(url: string): { repo: string; number: number; page: PrPage } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.host !== 'github.com' || parsed.username !== '' || parsed.password !== '') {
    return null;
  }
  const segments = parsed.pathname.split('/').slice(1);
  if (segments[segments.length - 1] === '') segments.pop();
  const [owner, name, pull, num, ...rest] = segments;
  if (owner === undefined || name === undefined || pull !== 'pull' || num === undefined) return null;
  const fullName = `${owner}/${name}`;
  if (!isRepo(fullName) || !/^[1-9][0-9]*$/.test(num)) return null;
  const parsedNumber = Number(num);
  if (!Number.isSafeInteger(parsedNumber)) return null;
  return { repo: fullName, number: parsedNumber, page: pageOf(rest) };
}
