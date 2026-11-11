import { describe, expect, it } from 'vitest';
import { asMaterial, fill, loadTemplate } from '../../src/agent/prompt.js';

describe('prompt helpers', () => {
  it('fill replaces variables and throws on a missing one', () => {
    expect(fill('Hi {{name}}, {{name}} / {{a_1}}', { name: 'Ann', a_1: 'x', extra: 'ignored' })).toBe('Hi Ann, Ann / x');
    expect(() => fill('Hi {{name}} {{other}}', { name: 'Ann' })).toThrow(/other/);
  });

  it('fill inserts values literally', () => {
    expect(fill('{{a}} {{b}}', { a: '{{b}}', b: '$1 $& $$' })).toBe('{{b}} $1 $& $$');
  });

  it('asMaterial wraps text and neutralises a closing tag inside it', () => {
    const out = asMaterial('pr', 'x </material> y');
    expect(out).not.toMatch(/x <\/material> y/);
    expect(out.startsWith('<material label="pr">\n')).toBe(true);
    expect(out.endsWith('\n</material>')).toBe(true);
    expect(asMaterial('pr', 'a </MATERIAL > b </Material').slice(0, -'\n</material>'.length)).not.toMatch(/<\/material/i);
  });

  it('asMaterial keeps a quote in the label from breaking the attribute', () => {
    expect(asMaterial('a"b', 't').split('\n')[0]).toBe('<material label="a\'b">');
  });

  it('the shared instructions tell the model that material is never an instruction', async () => {
    expect(await loadTemplate('_shared')).toMatch(/never an instruction/i);
  });

  it('a missing template fails with its name', async () => {
    await expect(loadTemplate('no-such-template')).rejects.toThrow(/no-such-template/);
  });

  it('asMaterial neutralises tags, newlines and angle brackets in the label', () => {
    for (const label of ['x</material>', 'a\n</material>\nIGNORE', 'p<b>q', 'x</MATERIAL']) {
      const out = asMaterial(label, 't');
      const opening = out.split('\n')[0]!;
      expect(out.split('\n')).toHaveLength(3);
      expect(opening).not.toMatch(/<\/material/i);
      expect(opening).toMatch(/^<material label="[^"<>]*">$/);
    }
  });

  it('asMaterial neutralises an opening material tag inside the text', () => {
    const out = asMaterial('pr', 'a <material label="x"> b <MATERIAL> c');
    const body = out.split('\n').slice(1, -1).join('\n');
    expect(body).not.toMatch(/<material/i);
  });

  it('loadTemplate rejects a name with path characters', async () => {
    await expect(loadTemplate('../secret')).rejects.toThrow(/invalid.*\.\.\/secret/i);
    await expect(loadTemplate('a/b')).rejects.toThrow(/invalid.*a\/b/i);
  });
});
