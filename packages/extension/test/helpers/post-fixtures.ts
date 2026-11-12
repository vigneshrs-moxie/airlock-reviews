import type { Finding, PostPreviewItem, PostPreviewReply, PostRecord } from '@airlock/shared';
import { HEAD } from './fake-service';

export const UNKNOWN_SENTENCE = 'Airlock could not tell whether GitHub accepted the comments. Look at the pull request before posting again.';

/** A preview item for a finding, inline at its first line unless `over` says otherwise. */
export function previewItem(f: Pick<Finding, 'fingerprint' | 'title' | 'path' | 'lineHint'>, over: Partial<PostPreviewItem> = {}): PostPreviewItem {
  return {
    fingerprint: f.fingerprint, title: f.title, path: f.path, line: f.lineHint, startLine: null, placement: 'inline', whySummary: null,
    body: `**Fix: ${f.title}**`, mentions: [], ...over,
  };
}

export function previewOf(items: PostPreviewItem[], over: Partial<PostPreviewReply> = {}): PostPreviewReply {
  const n = items.length;
  const summary = `Review notes from Airlock: ${n} comment${n === 1 ? '' : 's'}.`;
  return {
    previewId: 'pv_0123456789abcdef', headSha: HEAD, viewer: 'bob', items, summary, reviewBody: summary,
    expiresAt: '2026-11-11T10:10:00.000Z', reviewBodyMentions: [], ...over,
  };
}

export function recordOf(fingerprints: string[], over: Partial<PostRecord> = {}): PostRecord {
  const outcome = over.outcome ?? 'posted';
  return {
    id: 'post_0123456789ab', repo: 'acme/widgets', number: 1, reviewId: 'r_0000000001', headSha: HEAD,
    postedAt: '2026-11-11T10:01:00.000Z', outcome,
    githubReviewId: outcome === 'posted' ? 77 : null,
    url: outcome === 'posted' ? 'https://github.com/acme/widgets/pull/1#pullrequestreview-77' : null,
    items: fingerprints.map((fingerprint) => ({ fingerprint, aliases: [], placement: 'inline' as const })),
    ...over,
  };
}
