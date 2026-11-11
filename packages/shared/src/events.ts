import { z } from 'zod';
import { BriefSchema, ChangeMapSchema, ReviewDocumentSchema } from './review.js';

export const ReviewEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('stage'), stage: z.string(), status: z.enum(['start', 'done', 'error']), detail: z.string(),
  }),
  z.object({ type: z.literal('brief'), brief: BriefSchema }),
  z.object({ type: z.literal('map'), map: ChangeMapSchema }),
  z.object({ type: z.literal('done'), document: ReviewDocumentSchema }),
]);
export type ReviewEvent = z.infer<typeof ReviewEventSchema>;
