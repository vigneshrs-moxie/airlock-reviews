import { describe, expect, it } from 'vitest';
import { cutAtWord, gistOf, shortTitle } from '../../src/screens/summary';

describe('shortTitle', () => {
  it('is the summary stage\'s short title when there is one', () => {
    expect(shortTitle({ title: 'A long title the reviewer wrote about the guard', short: 'The guard is skipped' })).toBe('The guard is skipped');
  });

  it('is the whole title when it has at most 60 characters', () => {
    const title = 'x'.repeat(60);
    expect(shortTitle({ title })).toBe(title);
    expect(shortTitle({ title: 'Pause skips the guard' })).toBe('Pause skips the guard');
  });

  it('falls back to the title when the short title is blank', () => {
    expect(shortTitle({ title: 'Pause skips the guard', short: '  ' })).toBe('Pause skips the guard');
  });

  it('cuts a 141-character title at a word, with an ellipsis, to at most 60 characters', () => {
    const title = 'The pause handler calls the billing guard only after the account state is written, so a paused account can still place an order at checkouts.';
    expect([...title]).toHaveLength(141);
    const shown = shortTitle({ title });
    expect(shown.endsWith('…')).toBe(true);
    expect([...shown].length).toBeLessThanOrEqual(60);
    const kept = shown.slice(0, -1);
    expect(title.startsWith(kept)).toBe(true);
    // The cut falls between two words: the title goes on with a space after what is kept.
    expect(title[kept.length]).toBe(' ');
    expect(shown).toBe('The pause handler calls the billing guard only after the…');
  });

  it('cuts inside a first word longer than 60 characters', () => {
    const shown = shortTitle({ title: 'y'.repeat(80) });
    expect(shown).toBe(`${'y'.repeat(59)}…`);
  });

  it('drops a comma left at the cut', () => {
    // 58 characters, then a comma at the 59th and a space at the 60th: the cut falls right after the comma.
    const title = `${'word '.repeat(11)}abc, and then more words past the limit`;
    expect([...title][58]).toBe(',');
    expect(shortTitle({ title })).toBe(`${'word '.repeat(11)}abc…`);
  });

  it('drops a dash left at the cut', () => {
    // A spaced dash at the 59th character: the cut keeps neither the dash nor the space before it.
    const title = `${'word '.repeat(11)}ab - and then more words past the limit`;
    expect([...title][58]).toBe('-');
    expect(shortTitle({ title })).toBe(`${'word '.repeat(11)}ab…`);
  });
});

describe('gistOf', () => {
  it('is the summary stage\'s gist when there is one', () => {
    expect(gistOf({ happens: 'A paused account can still place an order. More detail.', gist: 'Paused accounts can still order.' }))
      .toBe('Paused accounts can still order.');
  });

  it('is the first sentence of happens when there is no gist', () => {
    expect(gistOf({ happens: 'A paused account can still place an order. The guard is never asked.' })).toBe('A paused account can still place an order.');
    expect(gistOf({ happens: 'Is it billed? Nobody knows.', gist: '' })).toBe('Is it billed?');
  });

  it('does not end a sentence at a dot inside a name', () => {
    expect(gistOf({ happens: '`npm test` reads content.js as text. It never runs it.' })).toBe('`npm test` reads content.js as text.');
  });

  it('is the whole of happens when it has no sentence end', () => {
    expect(gistOf({ happens: '  No full stop here  ' })).toBe('No full stop here');
  });

  it('cuts a first sentence longer than 200 characters at a word, with an ellipsis', () => {
    const sentence = `${'The guard runs late '.repeat(12).trim()}.`;
    expect([...sentence].length).toBeGreaterThan(200);
    const shown = gistOf({ happens: `${sentence} Second sentence.` });
    expect(shown.endsWith('…')).toBe(true);
    expect([...shown].length).toBeLessThanOrEqual(200);
    expect(sentence.startsWith(shown.slice(0, -1))).toBe(true);
    expect(sentence[shown.length - 1]).toBe(' ');
    expect(shown).not.toContain('Second');
  });

  it('is empty for an empty happens', () => {
    expect(gistOf({ happens: '' })).toBe('');
  });
});

// The review screen's cases (its rows use shortTitle; The change tab and the finding use gistOf).
describe('shortTitle on a review row', () => {
  it('is the short title when the review has one, trimmed', () => {
    expect(shortTitle({ title: 'A long technical title about the totals module', short: 'Totals can drift' })).toBe('Totals can drift');
    expect(shortTitle({ title: 'A long technical title about the totals module', short: ' Totals can drift ' })).toBe('Totals can drift');
  });
  it('is the whole title when there is no short one and it fits', () => {
    expect(shortTitle({ title: 'Totals can drift' })).toBe('Totals can drift');
    expect(shortTitle({ title: 'Totals can drift', short: '   ' })).toBe('Totals can drift');
  });
  it('cuts a 141-character title at a word, to at most 60 characters with an ellipsis', () => {
    const title = 'The totals module rounds each line before adding them, so an order of many small items can be a cent or more off the amount the customer pays';
    expect([...title]).toHaveLength(141);
    const cut = shortTitle({ title });
    expect(cut).toBe('The totals module rounds each line before adding them, so…');
    expect([...cut].length).toBeLessThanOrEqual(60);
    expect(title.startsWith(cut.slice(0, -1))).toBe(true);
    expect(title[cut.length - 1]).toMatch(/[\s,]/);
  });
  it('counts an emoji as one character, as the review document does', () => {
    const title = `${'😀'.repeat(60)}`;
    expect(shortTitle({ title })).toBe(title);
    expect(shortTitle({ title: `${title}a` })).toBe(`${'😀'.repeat(59)}…`);
  });
  it('drops a full stop left at the cut', () => {
    const title = `${'word '.repeat(11)}abc. And then more words past the limit`;
    expect([...title][58]).toBe('.');
    expect(shortTitle({ title })).toBe(`${'word '.repeat(11)}abc…`);
  });
});

describe('gistOf on The change tab', () => {
  it('is the gist when the review has one', () => {
    expect(gistOf({ gist: 'The tests never run the script.', happens: 'It reads the file. Then it checks strings.' })).toBe('The tests never run the script.');
  });
  it('is the first sentence of what happens when there is no gist', () => {
    expect(gistOf({ happens: 'It reads content.js as text. It never runs it.' })).toBe('It reads content.js as text.');
    expect(gistOf({ happens: 'No full stop at all' })).toBe('No full stop at all');
  });
  it('makes a line break inside the first sentence a space', () => {
    expect(gistOf({ happens: 'It reads\ncontent.js   as text. It never runs it.' })).toBe('It reads content.js as text.');
  });
  it('is at most 200 characters, cut at a word', () => {
    const happens = `${'word '.repeat(60)}end.`;
    const gist = gistOf({ happens });
    expect([...gist].length).toBeLessThanOrEqual(200);
    expect(gist.endsWith('word…')).toBe(true);
  });
});

describe('cutAtWord', () => {
  it('leaves text that fits, with its white space made single', () => {
    expect(cutAtWord('  a  b\nc ', 10)).toBe('a b c');
  });
});
