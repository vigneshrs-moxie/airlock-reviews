import { describe, expect, it } from 'vitest';
import { listFindings, neighbours, selectedInOrder, toggled } from '../../src/state/selection';
import { also, dismissal, finding } from '../screens/review-fixtures';

describe('listFindings', () => {
  it('puts the top list in rank order, then also found in document order', () => {
    const a = finding(1, { rank: 2 });
    const b = finding(2, { rank: 1 });
    const c = also(3);
    const d = also(4);
    const lists = listFindings([d, a, c, b], []);
    expect(lists.top.map((f) => f.id)).toEqual([b.id, a.id]);
    expect(lists.also.map((f) => f.id)).toEqual([d.id, c.id]);
    expect(lists.order.map((f) => f.id)).toEqual([b.id, a.id, d.id, c.id]);
  });
  it('leaves a dismissed finding out of every list and returns it with its dismissal', () => {
    const a = finding(1);
    const b = also(2);
    const x = dismissal(b, { reason: 'intended', text: 'Done on purpose.' });
    const lists = listFindings([a, b], [x]);
    expect(lists.order.map((f) => f.id)).toEqual([a.id]);
    expect(lists.also).toEqual([]);
    expect(lists.dismissed).toEqual([{ finding: b, dismissal: x }]);
  });
  it('ignores a dismissal that matches no finding in the document', () => {
    const lists = listFindings([finding(1)], [dismissal(finding(9))]);
    expect(lists.dismissed).toEqual([]);
    expect(lists.order).toHaveLength(1);
  });
  it('sorts findings with no rank after the ranked ones', () => {
    const lists = listFindings([finding(1, { rank: null }), finding(2, { rank: 1 })], []);
    expect(lists.top.map((f) => f.title)).toEqual(['Problem 2', 'Problem 1']);
  });
});

describe('selection', () => {
  it('toggles an id in a new set', () => {
    const empty: ReadonlySet<string> = new Set();
    const one = toggled(empty, 'a');
    expect([...one]).toEqual(['a']);
    expect(empty.size).toBe(0);
    expect(toggled(one, 'a').size).toBe(0);
  });
  it('returns the selected findings in list order, whatever order they were ticked in', () => {
    const order = [finding(1), finding(2), also(3)];
    const chosen = selectedInOrder(order, new Set([order[2]!.id, order[0]!.id, 'gone']));
    expect(chosen.map((f) => f.id)).toEqual([order[0]!.id, order[2]!.id]);
  });
  it('finds the neighbours of a finding and null at the ends', () => {
    const order = [finding(1), finding(2), finding(3)];
    expect(neighbours(order, order[0]!.id)).toEqual({ previous: null, next: order[1] });
    expect(neighbours(order, order[1]!.id)).toEqual({ previous: order[0], next: order[2] });
    expect(neighbours(order, order[2]!.id)).toEqual({ previous: order[1], next: null });
    expect(neighbours(order, 'gone')).toEqual({ previous: null, next: null });
  });
});
