import { describe, expect, it } from 'vitest';
import { cutAtWord, gistOf, shortTitle } from '../../src/screens/summary';

describe('shortTitle', () => {
  it('is the short title when the review has one', () => {
    expect(shortTitle({ title: 'A long technical title about the totals module', short: 'Totals can drift' })).toBe('Totals can drift');
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
  it('cuts a title with no space inside its first word', () => {
    const cut = shortTitle({ title: 'x'.repeat(100) });
    expect(cut).toBe(`${'x'.repeat(59)}…`);
  });
});

describe('gistOf', () => {
  it('is the gist when the review has one', () => {
    expect(gistOf({ gist: 'The tests never run the script.', happens: 'It reads the file. Then it checks strings.' })).toBe('The tests never run the script.');
  });
  it('is the first sentence of what happens when there is no gist', () => {
    expect(gistOf({ happens: 'It reads content.js as text. It never runs it.' })).toBe('It reads content.js as text.');
    expect(gistOf({ happens: 'No full stop at all' })).toBe('No full stop at all');
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
