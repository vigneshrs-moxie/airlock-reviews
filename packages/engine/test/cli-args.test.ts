import { describe, expect, it } from 'vitest';
import { parseArgs, usage } from '../src/cli-args.js';

const HELP_TAIL = /Run "airlock help" for usage\.$/;

describe('parseArgs', () => {
  it('parses a pull URL, a depth and a model', () => {
    expect(parseArgs(['review', 'https://github.com/a/b/pull/3', '--depth', 'deep', '--model', 'claude-opus-5-5'])).toEqual({
      command: 'review', ref: 'https://github.com/a/b/pull/3', depth: 'deep', model: 'claude-opus-5-5',
    });
  });
  it('defaults the depth to standard', () => {
    expect(parseArgs(['review', 'a/b#1'])).toEqual({ command: 'review', ref: 'a/b#1', depth: 'standard' });
  });
  it('requires --base and --head together', () => {
    expect(() => parseArgs(['review', 'a/b#1', '--base', 'abc'])).toThrow(/--head/);
    expect(() => parseArgs(['review', 'a/b#1', '--head', 'abc'])).toThrow(/--base/);
  });
  it('accepts --base and --head as 7 to 40 hex characters', () => {
    const r = parseArgs(['review', 'a/b#1', '--base', 'abcdef1', '--head', 'A'.repeat(40)]);
    expect(r).toMatchObject({ base: 'abcdef1', head: 'A'.repeat(40) });
  });
  it('rejects a sha that is too short, too long or not hex', () => {
    for (const bad of ['abcdef', 'a'.repeat(41), 'ghijklm']) {
      expect(() => parseArgs(['review', 'a/b#1', '--base', bad, '--head', 'abcdef1'])).toThrow(/--base/);
    }
  });
  it('splits --packs on commas and trims', () => {
    expect(parseArgs(['review', 'a/b#1', '--packs', 'core, web ,x'])).toMatchObject({ packs: ['core', 'web', 'x'] });
  });
  it('rejects an empty --packs list', () => {
    expect(() => parseArgs(['review', 'a/b#1', '--packs', ' , '])).toThrow(/--packs/);
    expect(() => parseArgs(['review', 'a/b#1', '--packs='])).toThrow(/--packs/);
  });
  it('reads --json', () => {
    expect(parseArgs(['review', 'a/b#1', '--json', 'out.json'])).toMatchObject({ json: 'out.json' });
  });
  it('accepts the --flag=value form', () => {
    expect(parseArgs(['review', 'a/b#1', '--depth=quick', '--model=m', '--json=o.json', '--packs=a,b'])).toEqual({
      command: 'review', ref: 'a/b#1', depth: 'quick', model: 'm', json: 'o.json', packs: ['a', 'b'],
    });
  });
  it('gives help for no arguments, help, --help and -h', () => {
    for (const argv of [[], ['help'], ['--help'], ['-h'], ['review', '--help']]) {
      expect(parseArgs(argv)).toEqual({ command: 'help' });
    }
  });
  it('rejects a depth outside quick, standard, deep', () => {
    const run = () => parseArgs(['review', 'a/b#1', '--depth', 'huge']);
    expect(run).toThrow(/--depth.*quick, standard, deep/);
    expect(run).toThrow(HELP_TAIL);
  });
  it('rejects an unknown flag', () => {
    expect(() => parseArgs(['review', 'a/b#1', '--wat'])).toThrow(/Unknown option "--wat"/);
    expect(() => parseArgs(['review', 'a/b#1', '--wat'])).toThrow(HELP_TAIL);
  });
  it('rejects a missing value', () => {
    expect(() => parseArgs(['review', 'a/b#1', '--model'])).toThrow(/--model needs a value/);
    expect(() => parseArgs(['review', 'a/b#1', '--model', '--json', 'x'])).toThrow(/--model needs a value/);
    expect(() => parseArgs(['review', 'a/b#1', '--model'])).toThrow(HELP_TAIL);
  });
  it('rejects a missing ref and a second positional argument', () => {
    expect(() => parseArgs(['review'])).toThrow(/needs a pull request/);
    expect(() => parseArgs(['review'])).toThrow(HELP_TAIL);
    expect(() => parseArgs(['review', 'a/b#1', 'c/d#2'])).toThrow(/Unexpected argument "c\/d#2"/);
    expect(() => parseArgs(['review', 'a/b#1', 'c/d#2'])).toThrow(HELP_TAIL);
  });
  it('rejects an unknown command', () => {
    expect(() => parseArgs(['merge', 'a/b#1'])).toThrow(/Unknown command "merge"/);
    expect(() => parseArgs(['merge'])).toThrow(HELP_TAIL);
  });
});

describe('usage', () => {
  it('shows the usage line and one line per option', () => {
    const text = usage();
    expect(text).toContain(
      'airlock review <owner/name#n | pull URL> [--depth quick|standard|deep] [--packs a,b] [--model <id>] [--base <sha> --head <sha>] [--json <file>]',
    );
    for (const flag of ['--depth', '--packs', '--model', '--base', '--head', '--json']) {
      expect(text.split('\n').filter((l) => l.trimStart().startsWith(flag))).toHaveLength(1);
    }
  });
});
