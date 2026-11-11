import { z } from 'zod';

/** The panel's one request to the content script of its own tab. Anything that does not match is ignored. */
export const JumpRequestSchema = z.strictObject({
  type: z.literal('airlock:jump'),
  anchorId: z.string().regex(/^diff-[0-9a-f]{64}$/),
  path: z.string().max(1000),
  line: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
});
export type JumpRequest = z.infer<typeof JumpRequestSchema>;

const ViewSchema = z.enum(['react', 'classic']).nullable();
/** Which view was recognised (null for neither) and the names of the selectors that found nothing. On every reply. */
const report = { view: ViewSchema, missing: z.array(z.string()) };

/**
 * `line`: the row was found and marked. `file`: the file was found and no line was asked for. `asked`: the address
 * fragment was set but the row was not found, or neither view was recognised.
 */
export const JumpReplySchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), how: z.enum(['line', 'file', 'asked']), ...report }),
  z.object({ ok: z.literal(false), reason: z.enum(['not-files-page', 'file-not-on-page']), ...report }),
]);
export type JumpReply = z.infer<typeof JumpReplySchema>;
