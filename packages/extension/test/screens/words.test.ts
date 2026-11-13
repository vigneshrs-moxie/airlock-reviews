import { describe, expect, it } from 'vitest';
import { clipQuote, stageWhere, dismissReasonWord, fromText, locationText, proofSide, severityWord } from '../../src/screens/words';
import { finding } from './review-fixtures';

describe('words', () => {
  it('says severities as Block, Fix, Ask and Note', () => {
    expect([severityWord('block'), severityWord('fix'), severityWord('ask'), severityWord('note')]).toEqual(['Block', 'Fix', 'Ask', 'Note']);
  });
  it('says dismissal reasons in words', () => {
    expect([dismissReasonWord('wrong'), dismissReasonWord('intended'), dismissReasonWord('not-now')]).toEqual([
      'The finding is mistaken', 'The code is right for a reason Airlock could not know', 'Hidden on this pull request only',
    ]);
  });
  it('says the side of a proof in words and anything else as written', () => {
    expect(proofSide('head')).toBe('in the pull request');
    expect(proofSide('base')).toBe('before the pull request');
    expect(proofSide('standard')).toBe("the team's corrections log");
    expect(proofSide('learned')).toBe('a recorded decision');
    expect(proofSide('something-new')).toBe('something-new');
  });
  it('cuts a code quote to 160 characters with an ellipsis and leaves a short one', () => {
    expect(clipQuote('short')).toBe('short');
    expect(clipQuote('x'.repeat(160))).toBe('x'.repeat(160));
    expect(clipQuote('x'.repeat(161))).toBe(`${'x'.repeat(160)}…`);
  });
  it('does not split a character when cutting', () => {
    const cut = clipQuote('😀'.repeat(200));
    expect([...cut]).toHaveLength(161);
    expect(cut.endsWith('…')).toBe(true);
  });
  it('writes the place of a finding by its anchor', () => {
    expect(locationText(finding(1))).toBe('src/file1.ts:10');
    expect(locationText(finding(1, { anchor: { status: 'outside-diff', startLine: null, endLine: null } }))).toBe('src/file1.ts, outside the changed lines');
    expect(locationText(finding(1, { anchor: { status: 'not-found', startLine: null, endLine: null } }))).toBe('src/file1.ts');
    expect(locationText(finding(1, { anchor: { status: 'in-diff', startLine: null, endLine: null } }))).toBe('src/file1.ts');
  });
  it('names the source by pack title and lens or rule id', () => {
    const packs = [{ id: 'orbit', title: 'Orbit' }];
    expect(fromText(finding(1, { source: { pack: 'orbit', lens: 'security', ruleId: null } }), packs)).toBe('Orbit · security');
    expect(fromText(finding(1, { source: { pack: 'orbit', lens: null, ruleId: 'R-12' } }), packs)).toBe('Orbit · R-12');
    expect(fromText(finding(1, { source: { pack: 'other', lens: null, ruleId: null } }), packs)).toBe('other');
  });
  it('says where something happened in words, and an unknown stage as written', () => {
    expect(stageWhere('schema')).toBe('when checking its format');
    expect(stageWhere('anchor')).toBe('when finding its line');
    expect(stageWhere('challenge')).toBe('in the challenge');
    expect(stageWhere('select')).toBe('when ranking');
    expect(stageWhere('lenses')).toBe('while reading the code');
    expect(stageWhere('lenses-deep')).toBe('in the closer second pass');
    expect(stageWhere('sweep')).toBe('in the rule sweep');
    expect(stageWhere('seams')).toBe('when checking how the parts fit');
    expect(stageWhere('map')).toBe('when grouping the changes');
    expect(stageWhere('brief')).toBe('when working out what the pull request does');
    expect(stageWhere('intake')).toBe('when getting the pull request');
    expect(stageWhere('packs')).toBe('when loading the rule packs');
    expect(stageWhere('shape')).toBe('when checking the kind of pull request');
    expect(stageWhere('facts')).toBe('when sorting the files');
    expect(stageWhere('store')).toBe('when saving the review');
    expect(stageWhere('new-stage')).toBe('new-stage');
    expect(stageWhere('toString')).toBe('toString');
  });
});
