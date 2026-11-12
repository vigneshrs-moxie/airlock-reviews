// @vitest-environment happy-dom
import { StrictMode } from 'react';
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

  it('on an extension repository the Extensions pack lists its lines with Remove, and no pack there is managed by the team', async () => {
    const repo = 'Moxie-Pest-Control-Phoenix/scheduling-tool-suite';
    const state: PanelState = { kind: 'ready', pr: prSummary({
      repo, stage: 'other', packs: [{ id: 'extensions', title: 'Extensions' }, { id: 'generic', title: 'Generic' }],
    }) };
    // As the service answers /learned for it: the Extensions pack names a kit, and its lines are still the person's own.
    const own = line(1, { pack: 'extensions', packTitle: 'Extensions', repo, text: 'The popup reads the active tab on purpose.' });
    const fact = line(2, { pack: 'extensions', packTitle: 'Extensions', repo, kind: 'product-knowledge', text: 'Routes are sent to the office sheet.' });
    const { fetchLearned, removeLearned } = await show(reply([own, fact]), {}, state);
    expect(fetchLearned).toHaveBeenCalledExactlyOnceWith(repo);
    const extensions = pack('Extensions');
    expect(extensions.getAllByRole('listitem').map((i) => i.textContent)).toEqual([
      expect.stringContaining(own.text), expect.stringContaining(fact.text),
    ]);
    expect(extensions.getAllByRole('button', { name: 'Remove' })).toHaveLength(2);
    expect(pack('Generic').getByText('Nothing learned yet.')).toBeTruthy();
    expect(screen.queryByText('Managed by the team; not edited here.')).toBeNull();

    fetchLearned.mockResolvedValue(reply([fact]));
    await click(extensions.getAllByRole('button', { name: 'Remove' })[0]!);
    await click(extensions.getAllByRole('button', { name: 'Remove' })[0]!);
    expect(removeLearned).toHaveBeenCalledExactlyOnceWith({ repo, pack: 'extensions', kind: 'wrong', key: own.key });
    expect(extensions.queryByText(own.text)).toBeNull();
    expect(extensions.getByText(fact.text)).toBeTruthy();
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
    expect(document.querySelector('.packs-screen .notice')?.textContent).toBe('Removed. It stops from the next review.');
  });

  it('shows the note when the line was no longer there, and the empty state after the last line goes', async () => {
    const { fetchLearned, removeLearned } = await show(reply([line(1)]));
    removeLearned.mockResolvedValue({ removed: false, note: 'That line was edited by hand, so it was left alone.' } satisfies RemoveLearnedReply);
    fetchLearned.mockResolvedValue(reply([]));
    const generic = pack('Generic');
    await click(generic.getByRole('button', { name: 'Remove' }));
    await click(generic.getByRole('button', { name: 'Remove' }));
    expect(document.querySelector('.packs-screen .notice')?.textContent).toBe('That line was edited by hand, so it was left alone.');
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
    const fetchLearned = vi.fn<(repo: string) => Promise<LearnedReply>>().mockReturnValueOnce(slow);
    render(
      <PanelScreen state={READY} dispatch={() => undefined} fetchStatus={() => Promise.reject(new Error('x'))} fetchLearned={fetchLearned} />,
    );
    await click(screen.getByRole('button', { name: 'Packs' }));
    expect(screen.getByText('Loading what Airlock has learned…')).toBeTruthy();
    await act(async () => { release(reply([])); await slow; });
    expect(screen.queryByText('Loading what Airlock has learned…')).toBeNull();
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

  it('under StrictMode a removal shows its note and Remove works again', async () => {
    const fetchLearned = vi.fn<(repo: string) => Promise<LearnedReply>>().mockResolvedValue(reply([line(1), line(2)]));
    const removeLearned = vi.fn<NonNullable<PanelScreenProps['removeLearned']>>().mockResolvedValue({ removed: true, note: 'Gone.' });
    render(
      <StrictMode>
        <PanelScreen state={READY} dispatch={() => undefined} fetchStatus={() => Promise.reject(new Error('x'))} fetchLearned={fetchLearned} removeLearned={removeLearned} />
      </StrictMode>,
    );
    await click(screen.getByRole('button', { name: 'Packs' }));
    fetchLearned.mockResolvedValue(reply([line(2)]));
    const generic = pack('Generic');
    await click(generic.getAllByRole('button', { name: 'Remove' })[0]!);
    await click(generic.getAllByRole('button', { name: 'Remove' })[0]!);
    expect(document.querySelector('.packs-screen .notice')?.textContent).toBe('Gone.');
    expect((generic.getByRole('button', { name: 'Remove' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('a removal that went through keeps its note when the list cannot be read again, with the reason and no stale lines', async () => {
    const { fetchLearned } = await show(reply([line(1)]));
    fetchLearned.mockRejectedValue(new ServiceError('problem', 'The pack folder is unreadable.'));
    const generic = pack('Generic');
    await click(generic.getByRole('button', { name: 'Remove' }));
    await click(generic.getByRole('button', { name: 'Remove' }));
    expect(document.querySelector('.packs-screen .notice')?.textContent).toBe('Removed. It stops from the next review.');
    expect(screen.getByText('The pack folder is unreadable.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Load again' })).toBeTruthy();
    expect(screen.queryByText('Learned line 1.')).toBeNull();
  });

  it('says Removed. when the service sent no note', async () => {
    const { removeLearned } = await show(reply([line(1)]));
    removeLearned.mockResolvedValue({ removed: true, note: null });
    const generic = pack('Generic');
    await click(generic.getByRole('button', { name: 'Remove' }));
    await click(generic.getByRole('button', { name: 'Remove' }));
    expect(document.querySelector('.packs-screen .notice')?.textContent).toBe('Removed.');
  });

  it('a double press on the question\'s Remove sends once', async () => {
    const { removeLearned } = await show(reply([line(1)]));
    const generic = pack('Generic');
    await click(generic.getByRole('button', { name: 'Remove' }));
    const confirm = generic.getByRole('button', { name: 'Remove' });
    await act(async () => { fireEvent.click(confirm); fireEvent.click(confirm); });
    expect(removeLearned).toHaveBeenCalledTimes(1);
  });

  it('focus: the question takes it, Keep gives it back, a refusal returns it to Remove, a removal moves it to the pack heading; each is announced', async () => {
    const { removeLearned } = await show(reply([line(1)]));
    const generic = pack('Generic');
    const live = () => document.querySelector('[aria-live]')!.textContent;
    await click(generic.getByRole('button', { name: 'Remove' }));
    expect(document.activeElement?.textContent).toBe('Remove this line? The reviewer stops following it from the next review.');
    expect(live()).toBe('Remove this line? The reviewer stops following it from the next review.');
    await click(generic.getByRole('button', { name: 'Keep' }));
    expect(document.activeElement).toBe(generic.getByRole('button', { name: 'Remove' }));
    removeLearned.mockRejectedValueOnce(new ServiceError('problem', 'Refused for now.'));
    await click(generic.getByRole('button', { name: 'Remove' }));
    await click(generic.getByRole('button', { name: 'Remove' }));
    expect(document.activeElement).toBe(generic.getByRole('button', { name: 'Remove' }));
    expect(live()).toBe('Refused for now.');
    await click(generic.getByRole('button', { name: 'Remove' }));
    await click(generic.getByRole('button', { name: 'Remove' }));
    expect(document.activeElement?.textContent).toBe('Generic');
    expect(live()).toBe('Removed. It stops from the next review.');
  });

  it('the question\'s Remove has its reason when the panel goes offline while it is open', async () => {
    const view = await show(reply([line(1)]));
    await click(within(document.querySelector<HTMLElement>('.packs-screen')!).getByRole('button', { name: 'Remove' }));
    view.rerender(
      <PanelScreen state={{ kind: 'offline', ready: prSummary() }} dispatch={() => undefined} fetchStatus={() => Promise.reject(new Error('x'))}
        fetchLearned={view.fetchLearned} removeLearned={view.removeLearned} />,
    );
    const confirm = screen.getByRole('button', { name: 'Remove' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    expect(document.getElementById(confirm.getAttribute('aria-describedby')!)?.textContent).toBe('Removing a line needs the Airlock service, which is not answering.');
  });

  it('a refusal shows only under the line with the same pack, kind and key', async () => {
    const { removeLearned } = await show(reply([line(1), line(1, { kind: 'product-knowledge' })]));
    removeLearned.mockRejectedValue(new ServiceError('problem', 'Refused.'));
    const generic = pack('Generic');
    await click(generic.getAllByRole('button', { name: 'Remove' })[0]!);
    await click(generic.getAllByRole('button', { name: 'Remove' })[0]!);
    expect(generic.getAllByRole('alert')).toHaveLength(1);
  });

  it('lines of a pack the pull request does not list are shown under their own pack title', async () => {
    await show(reply([line(1), line(2, { pack: 'extra', packTitle: 'Extra pack', text: 'From elsewhere.' })]));
    expect(pack('Extra pack').getByText('From elsewhere.')).toBeTruthy();
  });

  it('says it could not reach the service when the read gets no answer', async () => {
    await show(new ServiceError('offline', 'The Airlock service is not answering.'));
    expect(screen.getByText('Airlock could not reach its service to read what it has learned.')).toBeTruthy();
  });

  it('a removal whose answer is lost says it cannot tell, and reads the lines again', async () => {
    const { removeLearned, fetchLearned } = await show(reply([line(1), line(2)]));
    removeLearned.mockRejectedValue(new ServiceError('offline', 'The Airlock service is not answering.'));
    // The line had gone: the list read again no longer holds it.
    fetchLearned.mockResolvedValue(reply([line(2)]));
    const generic = pack('Generic');
    await click(generic.getAllByRole('button', { name: 'Remove' })[0]!);
    await click(generic.getAllByRole('button', { name: 'Remove' })[0]!);
    const said = 'Airlock got no answer from its service, so it cannot tell whether the line was removed. The list below is read again.';
    expect(screen.getByText(said, { selector: '.packs-screen .notice' })).toBeTruthy();
    expect(screen.queryByText('Airlock could not reach its service to read what it has learned.')).toBeNull();
    expect(fetchLearned).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('Learned line 1.')).toBeNull();
    expect(screen.getByText('Learned line 2.')).toBeTruthy();
    expect(document.querySelector('[aria-live]')?.textContent).toBe(said);
  });

  it('a removal never sent because the proof got no answer says nothing was removed, on its line, and reads nothing again', async () => {
    const { removeLearned, fetchLearned } = await show(reply([line(1), line(2)]));
    removeLearned.mockRejectedValue(new ServiceError('offline', 'The Airlock service is not answering.', true));
    const generic = pack('Generic');
    await click(generic.getAllByRole('button', { name: 'Remove' })[0]!);
    await click(generic.getAllByRole('button', { name: 'Remove' })[0]!);
    const said = 'Airlock could not reach its service, so nothing was removed.';
    expect(generic.getByRole('alert').textContent).toBe(said);
    expect(screen.queryByText(/cannot tell whether the line was removed/)).toBeNull();
    expect(fetchLearned).toHaveBeenCalledTimes(1);
    expect(generic.getByText('Learned line 1.')).toBeTruthy();
    expect(generic.getAllByRole('button', { name: 'Remove' })).toHaveLength(2);
  });

  it('a removal answered after the repository changed fills in nothing of the old repository and reads nothing again', async () => {
    let answer: (r: RemoveLearnedReply) => void = () => undefined;
    const view = await show(reply([line(1)]));
    view.removeLearned.mockReturnValue(new Promise<RemoveLearnedReply>((r) => { answer = r; }));
    const generic = pack('Generic');
    await click(generic.getByRole('button', { name: 'Remove' }));
    await click(generic.getByRole('button', { name: 'Remove' }));
    // The tab moves to another repository, whose lines load.
    view.fetchLearned.mockResolvedValue(reply([line(5, { repo: 'acme/other', text: 'Of the other repository.' })]));
    await act(async () => {
      view.rerender(
        <PanelScreen state={{ kind: 'ready', pr: prSummary({ repo: 'acme/other' }) }} dispatch={() => undefined} fetchStatus={() => Promise.reject(new Error('x'))}
          fetchLearned={view.fetchLearned} removeLearned={view.removeLearned} />,
      );
    });
    expect(screen.getByText('Of the other repository.')).toBeTruthy();
    const reads = view.fetchLearned.mock.calls.length;
    // The first repository's answer arrives: no read of it follows, and nothing is said here.
    view.fetchLearned.mockResolvedValue(reply([line(1)]));
    await act(async () => { answer({ removed: true, note: null }); });
    expect(view.fetchLearned.mock.calls.length).toBe(reads);
    expect(view.fetchLearned).toHaveBeenLastCalledWith('acme/other');
    expect(screen.getByText('Of the other repository.')).toBeTruthy();
    expect(screen.queryByText('Learned line 1.')).toBeNull();
    expect(screen.queryByText('Removed.')).toBeNull();
  });

  it('a different pull request drops the old lines at once and loads the new ones', async () => {
    const view = await show(reply([line(1)]));
    let release: (r: LearnedReply) => void = () => undefined;
    view.fetchLearned.mockReturnValue(new Promise<LearnedReply>((r) => { release = r; }));
    view.rerender(
      <PanelScreen state={{ kind: 'ready', pr: prSummary({ repo: 'acme/other' }) }} dispatch={() => undefined} fetchStatus={() => Promise.reject(new Error('x'))}
        fetchLearned={view.fetchLearned} removeLearned={view.removeLearned} />,
    );
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByText('Learned line 1.')).toBeNull();
    expect(view.fetchLearned).toHaveBeenLastCalledWith('acme/other');
    await act(async () => { release(reply([line(2)])); });
    expect(screen.getByText('Learned line 2.')).toBeTruthy();
  });
});
