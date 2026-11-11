import { describe, expect, it } from 'vitest';
import { isWholeEntry, isWholeUnits, unitsOf } from '../../src/challenge/standards-text.js';

const NO_EVAL = 'No `eval`, `new Function`, `setTimeout("string")`, or scripts fetched from a URL.';
const LEAD = 'Never do the following in a billing job:';
const STANDARD = [
  '# Extensions',
  '',
  'Code from strings is never allowed in an extension. No',
  '`eval`, `new Function`, `setTimeout("string")`, or scripts fetched from a URL.',
  '',
  'Do not let members pause twice in one year, i.e. a second pause request within twelve months is refused.',
  '',
  LEAD,
  '- retry a failed charge without the original idempotency key',
  '- charge a plan that is paused or cancelled',
  '',
  '## Pauses',
  'Members on a paused plan are never charged by the nightly billing job.',
  '',
  '> Offices may share a plan only when the account owner',
  '> agrees in writing.',
  '',
  '| Office | Billing day must be the first of the month |',
].join('\n');

describe('unitsOf', () => {
  it('joins wrapped lines, splits sentences, keeps a lead-in with each entry, and marks headings', () => {
    expect(unitsOf(STANDARD)).toEqual([
      null,
      'Codefromstringsisneverallowedinanextension.',
      'No`eval`,`newFunction`,`setTimeout("string")`,orscriptsfetchedfromaURL.',
      'Donotletmemberspausetwiceinoneyear,i.e.asecondpauserequestwithintwelvemonthsisrefused.',
      'Neverdothefollowinginabillingjob:retryafailedchargewithouttheoriginalidempotencykey',
      'Neverdothefollowinginabillingjob:chargeaplanthatispausedorcancelled',
      null,
      'Membersonapausedplanareneverchargedbythenightlybillingjob.',
      'Officesmayshareaplanonlywhentheaccountowneragreesinwriting.',
      '|Office|Billingdaymustbethefirstofthemonth|',
    ]);
  });

  it('ends a sentence only before an uppercase letter, a digit, a quote, a backtick, a bracket or the end', () => {
    expect(unitsOf('One rule applies. two words follow. "Quoted" next. (Bracketed) last. 3 more!')).toEqual([
      'Oneruleapplies.twowordsfollow.', '"Quoted"next.', '(Bracketed)last.', '3more!',
    ]);
  });

  it('keeps a colon line as an ordinary sentence when no list follows it', () => {
    expect(unitsOf('These apply:\nAll of them.')).toEqual(['Theseapply:Allofthem.']);
    expect(unitsOf('These apply:\n\nAll of them.')).toEqual(['Theseapply:', 'Allofthem.']);
  });

  it('starts a block before a list item, heading, table row or block quote, and after a heading or table row', () => {
    expect(unitsOf('First line\n- item one\n# Head\nafter head\n| row |\nafter row\n> quoted')).toEqual([
      'Firstline', 'itemone', null, 'afterhead', '|row|', 'afterrow', 'quoted',
    ]);
  });
});

describe('isWholeUnits', () => {
  it.each([
    ['the whole sentence joined across the wrap', NO_EVAL],
    ['two sentences as wrapped in the file', `Code from strings is never allowed in an extension. No\n${NO_EVAL.slice(3)}`],
    ['the sentence with "i.e." in it', 'Do not let members pause twice in one year, i.e. a second pause request within twelve months is refused.'],
    ['the lead-in with one entry', `${LEAD}\n- retry a failed charge without the original idempotency key`],
    ['the lead-in with both entries', `${LEAD}\n- retry a failed charge without the original idempotency key\n- charge a plan that is paused or cancelled`],
    ['the sentence under a heading', 'Members on a paused plan are never charged by the nightly billing job.'],
    ['a wrapped block quote as one sentence', 'Offices may share a plan only when the account owner agrees in writing.'],
    ['a whole table row', '| Office | Billing day must be the first of the month |'],
  ])('accepts %s', (_what, quote) => {
    expect(isWholeUnits(quote, STANDARD)).toBe(true);
  });

  it.each([
    ['a wrapped line whose negation is on the line above', NO_EVAL.slice(3)],
    ['the tail after "i.e."', 'a second pause request within twelve months is refused.'],
    ['a list entry without its lead-in', 'retry a failed charge without the original idempotency key'],
    ['a heading with the sentence under it', '## Pauses\nMembers on a paused plan are never charged by the nightly billing job.'],
    ['one cell of a table row', 'Billing day must be the first of the month'],
    ['a sentence that is not there', 'Members on a paused plan are charged by the nightly billing job.'],
  ])('refuses %s', (_what, quote) => {
    expect(isWholeUnits(quote, STANDARD)).toBe(false);
  });

  it('refuses a whole unit shorter than 40 characters or four words', () => {
    expect(isWholeUnits('Pauses may run 90 days.', 'Pauses may run 90 days.')).toBe(false);
    const threeWords = 'Always use chargeIdempotencyKeyForEveryNightlyBillingRun.';
    expect(isWholeUnits(threeWords, threeWords)).toBe(false);
    const fourWords = 'Always use the chargeIdempotencyKeyForEveryNightlyBillingRun.';
    expect(isWholeUnits(fourWords, fourWords)).toBe(true);
  });

  it('refuses a blank quote', () => {
    expect(isWholeUnits('   ', STANDARD)).toBe(false);
  });
});

describe('isWholeEntry', () => {
  const ENTRY = 'A paused plan keeps its original renewal date when it resumes. Staff may extend a pause once.';

  it('accepts the whole entry, ignoring whitespace and a leading list marker', () => {
    expect(isWholeEntry(ENTRY, ENTRY)).toBe(true);
    expect(isWholeEntry(`- ${ENTRY.replace(' Staff', '\n  Staff')}`, ENTRY)).toBe(true);
  });

  it('refuses part of the entry, more than the entry, and a short entry', () => {
    expect(isWholeEntry('A paused plan keeps its original renewal date when it resumes.', ENTRY)).toBe(false);
    expect(isWholeEntry(`${ENTRY} And more.`, ENTRY)).toBe(false);
    expect(isWholeEntry('Refunds are manual.', 'Refunds are manual.')).toBe(false);
  });
});
