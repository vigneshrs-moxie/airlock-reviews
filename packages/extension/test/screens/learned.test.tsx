// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { LearnedLine, LearnedReply, RemoveLearnedReply } from '@airlock/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServiceError } from '../../src/client/service';
import { PanelScreen, type PanelScreenProps } from '../../src/screens/PanelScreen';
import type { PanelState } from '../../src/state/reduce';
import { prSummary } from './fixtures';

afterEach(cleanup);

const line = (n: number, over: Partial<LearnedLine> = {}): LearnedLine => ({
  pack: 'generic', packTitle: 'Generic', kind: 'wrong', date: `2026-11-${String(10 - n).padStart(2, '0')}`, repo: 'acme/widgets',
  text: `Learned line ${n}.`, key: String(n).padStart(16, '0'), appliesHere: true, removable: true, ...over,
});
const reply = (lines: LearnedLine[], cap = 300): LearnedReply => ({ lines, cap });

const READY: PanelState = { kind: 'ready', pr: prSummary({ packs: [{ id: 'generic', title: 'Generic' }, { id: 'orbit', title: 'Orbit' }] }) };

async function show(lines: LearnedReply | Error, extra: Partial<PanelScreenProps> = {}, state: PanelState = READY) {
  const fetchLearned = vi.fn<(repo: string) => Promise<LearnedReply>>(() => (lines instanceof Error ? Promise.reject(lines) : Promise.resolve(lines)));
  const removeLearned = vi.fn<NonNullable<PanelScreenProps['removeLearned']>>().mockResolvedValue({ removed: true, note: 'Removed. It stops from the next review.' });
  const view = render(
    <PanelScreen state={state} dispatch={() => undefined} onOpenPacks={() => undefined} fetchStatus={() => Promise.reject(new Error('x'))}
      fetchLearned={fetchLearned} removeLearned={removeLearned} {...extra} />,
  );
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Packs' })); });
  return { fetchLearned, removeLearned, ...view };
}
const pack = (title: string) => within(within(document.querySelector<HTMLElement>('.packs-screen')!).getByText(title).closest('li') as HTMLElement);
const click = async (el: HTMLElement) => { await act(async () => { fireEvent.click(el); }); };

describe('learned lines under Packs', () => {
  it('lists the lines of each pack newest first with their kind and where they apply', async () => {
    const { fetchLearned } = await show(reply([
      line(1, { text: 'First one.' }),
      line(2, { kind: 'product-knowledge', text: 'Second one.', appliesHere: false, repo: 'acme/other' }),
      line(3, { text: 'Third one.', appliesHere: false, repo: null }),
      line(4, { pack: 'orbit', packTitle: 'Orbit', text: 'In orbit.' }),
    ]));
    expect(fetchLearned).toHaveBeenCalledExactlyOnceWith('acme/widgets');
    const generic = pack('Generic');
    const items = generic.getAllByRole('listitem');
    expect(items.map((i) => i.textContent)).toEqual([
      expect.stringContaining('First one.'), expect.stringContaining('Second one.'), expect.stringContaining('Third one.'),
    ]);
    expect(within(items[0]!).getByText('2026-11-09')).toBeTruthy();
    expect(within(items[0]!).getByText('Wrong')).toBeTruthy();
    expect(within(items[0]!).getByText('Applies to this repository')).toBeTruthy();
    expect(within(items[1]!).getByText('Product fact')).toBeTruthy();
    expect(within(items[1]!).getByText('Only for acme/other')).toBeTruthy();
    expect(within(items[2]!).getByText('Not used for this repository')).toBeTruthy();
    expect(pack('Orbit').getByText('In orbit.')).toBeTruthy();
    expect(generic.queryByText('In orbit.')).toBeNull();
  });

  it('says Nothing learned yet for a pack without lines, and the kit is managed by the team', async () => {
    const state: PanelState = { kind: 'ready', pr: prSummary({ packs: [
      { id: 'generic', title: 'Generic' }, { id: 'raj-standard', title: 'Team standard' }, { id: 'kit', title: 'Kit two' },
    ] }) };
    await show(reply([line(1, { pack: 'kit', packTitle: 'Kit two', removable: false, text: 'Kit rule.' })]), {}, state);
    expect(pack('Generic').getByText('Nothing learned yet.')).toBeTruthy();
    const team = pack('Team standard');
    expect(team.getByText('Managed by the team; not edited here.')).toBeTruthy();
    expect(team.queryByText('Nothing learned yet.')).toBeNull();
    const kit = pack('Kit two');
    expect(kit.getByText('Kit rule.')).toBeTruthy();
    expect(kit.getByText('Managed by the team; not edited here.')).toBeTruthy();
    expect(kit.queryByRole('button', { name: 'Remove' })).toBeNull();
  });

  it('Remove asks in place, then removes and shows the note', async () => {
    const first = reply([line(1), line(2)]);
    const second = reply([line(2)]);
    const { fetchLearned, removeLearned } = await show(first);
    fetchLearned.mockResolvedValue(second);
    const generic = pack('Generic');
    await click(generic.getAllByRole('button', { name: 'Remove' })[0]!);
    expect(generic.getByText('Remove this line? The reviewer stops following it from the next review.')).toBeTruthy();
    expect(removeLearned).not.toHaveBeenCalled();
    await click(generic.getByRole('button', { name: 'Keep' }));
    expect(generic.queryByText(/Remove this line\?/)).toBeNull();
    expect(removeLearned).not.toHaveBeenCalled();
    await click(generic.getAllByRole('button', { name: 'Remove' })[0]!);
    await click(generic.getAllByRole('button', { name: 'Remove' })[0]!);
    expect(removeLearned).toHaveBeenCalledExactlyOnceWith({ repo: 'acme/widgets', pack: 'generic', kind: 'wrong', key: '0000000000000001' });
    expect(fetchLearned).toHaveBeenCalledTimes(2);
    expect(generic.queryByText('Learned line 1.')).toBeNull();
    expect(generic.getByText('Learned line 2.')).toBeTruthy();
    expect(generic.getByText('Removed. It stops from the next review.')).toBeTruthy();
  });

  it('shows the note when the line was no longer there, and the empty state after the last line goes', async () => {
    const { fetchLearned, removeLearned } = await show(reply([line(1)]));
    removeLearned.mockResolvedValue({ removed: false, note: 'That line was edited by hand, so it was left alone.' } satisfies RemoveLearnedReply);
    fetchLearned.mockResolvedValue(reply([]));
    const generic = pack('Generic');
    await click(generic.getByRole('button', { name: 'Remove' }));
    await click(generic.getByRole('button', { name: 'Remove' }));
    expect(generic.getByText('That line was edited by hand, so it was left alone.')).toBeTruthy();
    expect(generic.getByText('Nothing learned yet.')).toBeTruthy();
  });

  it('a kit line has no Remove', async () => {
    await show(reply([line(1, { removable: false }), line(2)]));
    const buttons = pack('Generic').getAllByRole('button', { name: 'Remove' });
    expect(buttons).toHaveLength(1);
  });

  it('a refusal from the service is shown and the line stays', async () => {
    const { removeLearned, fetchLearned } = await show(reply([line(1)]));
    removeLearned.mockRejectedValue(new ServiceError('problem', 'The team kit is not edited here.'));
    const generic = pack('Generic');
    await click(generic.getByRole('button', { name: 'Remove' }));
    await click(generic.getByRole('button', { name: 'Remove' }));
    expect(generic.getByRole('alert').textContent).toBe('The team kit is not edited here.');
    expect(generic.getByText('Learned line 1.')).toBeTruthy();
    expect(fetchLearned).toHaveBeenCalledTimes(1);
    expect(generic.getByRole('button', { name: 'Remove' })).toBeTruthy();
  });

  it('markup in a learned line is shown as characters', async () => {
    const text = '<img src=x onerror=alert(1)> **bold** [a](https://evil.example)';
    await show(reply([line(1, { text })]));
    const generic = pack('Generic');
    expect(generic.getByText(text)).toBeTruthy();
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('.packs-screen a')).toBeNull();
  });

  it('says it is loading, then says in words when the list could not be read, and loads again on request', async () => {
    let release: (r: LearnedReply) => void = () => undefined;
    const slow = new Promise<LearnedReply>((r) => { release = r; });
    const fetchLearned = vi.fn<(repo: string) => Promise<LearnedReply>>().mockReturnValueOnce(slow).mockRejectedValueOnce(new Error('down')).mockResolvedValue(reply([line(1)]));
    render(
      <PanelScreen state={READY} dispatch={() => undefined} fetchStatus={() => Promise.reject(new Error('x'))} fetchLearned={fetchLearned} />,
    );
    await click(screen.getByRole('button', { name: 'Packs' }));
    expect(screen.getByText('Loading what Airlock has learned…')).toBeTruthy();
    await act(async () => { release(reply([])); await slow; });
    expect(screen.queryByText('Loading what Airlock has learned…')).toBeNull();
    // A removal reload that fails keeps the lines and says so.
    cleanup();
    fetchLearned.mockReset().mockRejectedValueOnce(new ServiceError('problem', 'The pack folder is unreadable.')).mockResolvedValue(reply([line(1)]));
    render(<PanelScreen state={READY} dispatch={() => undefined} fetchStatus={() => Promise.reject(new Error('x'))} fetchLearned={fetchLearned} />);
    await click(screen.getByRole('button', { name: 'Packs' }));
    expect(screen.getByText('The pack folder is unreadable.')).toBeTruthy();
    await click(screen.getByRole('button', { name: 'Load again' }));
    expect(screen.getByText('Learned line 1.')).toBeTruthy();
    expect(screen.queryByText('The pack folder is unreadable.')).toBeNull();
  });

  it('shows the count against the cap for a kind with over 250 lines in a pack', async () => {
    const many = Array.from({ length: 251 }, (_, i) => line(i + 1, { key: String(i + 1).padStart(16, '0') }));
    await show(reply([...many, line(900, { kind: 'product-knowledge', key: '0000000000000900' })], 300));
    const generic = pack('Generic');
    expect(generic.getByText('251 of 300 lines')).toBeTruthy();
    expect(generic.getAllByText(/ of 300 lines$/)).toHaveLength(1);
  });

  it('does not show a count at 250 lines', async () => {
    await show(reply(Array.from({ length: 250 }, (_, i) => line(i + 1)), 300));
    expect(screen.queryByText(/of 300 lines/)).toBeNull();
  });

  it('while the panel is offline Remove is disabled with its reason', async () => {
    const offline: PanelState = { kind: 'offline', ready: prSummary() };
    await show(reply([line(1)]), {}, offline);
    const remove = screen.getByRole('button', { name: 'Remove' }) as HTMLButtonElement;
    expect(remove.disabled).toBe(true);
    expect(screen.getByText('Removing a line needs the Airlock service, which is not answering.')).toBeTruthy();
    expect(remove.getAttribute('aria-describedby')).toBeTruthy();
  });
});
