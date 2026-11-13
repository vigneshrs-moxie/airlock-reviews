// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { LearnedLine, LearnedReply, ServiceStatus } from '@airlock/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PanelScreen, type PanelScreenProps } from '../../src/screens/PanelScreen';
import { packsLine } from '../../src/screens/Settings';
import type { PanelState } from '../../src/state/reduce';
import { startSize, type Size } from '../../src/state/size';
import { prSummary, running } from './fixtures';
import { finding, reviewState } from './review-fixtures';

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute('style');
  delete document.documentElement.dataset.size;
});

const STATUS: ServiceStatus = { version: '0.2.0', claude: true, gh: true, packsDir: '/p', running: [] };

const line = (n: number, over: Partial<LearnedLine> = {}): LearnedLine => ({
  pack: 'generic', packTitle: 'Generic', kind: 'wrong', date: '2026-11-01', repo: 'acme/widgets',
  text: `Learned line ${n}.`, key: String(n).padStart(16, '0'), appliesHere: true, removable: true, ...over,
});
const FOUR: LearnedReply = { lines: [line(1), line(2), line(3), line(4, { pack: 'orbit', packTitle: 'Orbit' })], cap: 300 };
const TWO_PACKS = prSummary({ packs: [{ id: 'generic', title: 'Generic' }, { id: 'orbit', title: 'Orbit' }] });

function show(state: PanelState, extra: Partial<PanelScreenProps> = {}) {
  const props: PanelScreenProps = {
    state, dispatch: vi.fn(), fetchStatus: vi.fn().mockResolvedValue(STATUS), fetchLearned: vi.fn().mockResolvedValue(FOUR),
    defaultDepth: null, onDefaultDepth: vi.fn(), showNotes: true, onShowNotes: vi.fn(), ...extra,
  };
  const view = render(<PanelScreen {...props} />);
  return { props, ...view };
}

const press = async (name: string) => { await act(async () => { fireEvent.click(screen.getByRole('button', { name })); }); };
const openSettings = () => press('Settings');
/** The line under a row that opens another screen. */
const lineOf = (name: string): string => {
  const id = screen.getByRole('button', { name }).getAttribute('aria-describedby') ?? '';
  return document.getElementById(id)?.textContent ?? '';
};

/** A store whose size the test can read, and whose writes it can make fail. */
function sizeStore(initial: Size = 'm') {
  let stored = initial;
  const setSize = vi.fn(async (size: Size) => { stored = size; });
  return { getSize: async () => stored, setSize, stored: () => stored };
}
function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  const data: Record<string, string> = {};
  return { getItem: (k) => data[k] ?? null, setItem: (k, v) => { data[k] = v; } };
}

describe('the Settings screen', () => {
  const states: [string, PanelState][] = [
    ['ready', { kind: 'ready', pr: TWO_PACKS }],
    ['running', running({ pr: TWO_PACKS })],
    ['review', reviewState([finding(1)])],
    ['offline', { kind: 'offline', ready: TWO_PACKS }],
    ['not paired', { kind: 'unpaired' }],
  ];
  for (const [name, state] of states) {
    it(`holds every row, in order, while the panel is ${name}`, async () => {
      const offline = name === 'offline' || name === 'not paired';
      show(state, offline ? { fetchStatus: vi.fn().mockRejectedValue(new Error('x')), fetchLearned: vi.fn().mockRejectedValue(new Error('x')) } : {});
      await openSettings();
      expect(screen.getByRole('heading', { level: 2, name: 'Settings' })).toBe(document.activeElement);
      expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(['Display', 'On GitHub', 'Reviews', 'Help']);
      const sizes = screen.getByRole('radiogroup', { name: 'Text and button size' });
      expect(within(sizes).getAllByRole('radio').map((r) => r.parentElement?.textContent)).toEqual(['Small', 'Default', 'Large', 'Largest']);
      expect(screen.getByText('Changes everything in the panel: text, buttons and spacing. Saved on this computer.')).toBeTruthy();
      expect(screen.getByRole('switch', { name: 'Notes in the diff' })).toBeTruthy();
      expect(screen.getByText('Private notes under the lines of Files changed. Only you see them.')).toBeTruthy();
      expect(within(screen.getByRole('radiogroup', { name: 'Default depth' })).getAllByRole('radio')).toHaveLength(4);
      const packs = lineOf('Packs and learned lines');
      const service = lineOf('Service');
      if (name === 'not paired') {
        expect(packs).toBe('Pair Airlock to see its packs.');
        expect(service).toBe('Not paired');
      } else if (name === 'offline') {
        expect(packs).toBe('2 packs for this repository');
        expect(service).toBe('Airlock could not reach its service.');
      } else {
        expect(packs).toBe('2 packs for this repository · 4 lines learned');
        expect(service).toBe('Running · paired · Claude found · GitHub signed in');
      }
    });
  }

  it('says Checking… while the service is read, and only what is known', async () => {
    let resolve!: (s: ServiceStatus) => void;
    show({ kind: 'no-pr' }, { fetchStatus: vi.fn().mockReturnValue(new Promise<ServiceStatus>((r) => { resolve = r; })) });
    await openSettings();
    expect(lineOf('Service')).toBe('Checking…');
    await act(async () => { resolve({ ...STATUS, claude: false, gh: false }); });
    // No pull request on screen proves the pairing either way, so the line says nothing of it.
    expect(lineOf('Service')).toBe('Running · Claude not found · GitHub not signed in');
  });

  it('says to pair, not to open a pull request, on an unpaired panel, whether or not a pull request is known', () => {
    expect(packsLine(TWO_PACKS, 4, false)).toBe('Pair Airlock to see its packs.');
    expect(packsLine(null, null, false)).toBe('Pair Airlock to see its packs.');
    expect(packsLine(null, null, null)).toBe('Open a pull request to see its packs.');
    expect(packsLine(TWO_PACKS, 4, true)).toBe('2 packs for this repository · 4 lines learned');
  });

  it('counts one pack and one line in the singular, and says the lines once they are read', async () => {
    let release!: (r: LearnedReply) => void;
    show({ kind: 'ready', pr: prSummary({ packs: [{ id: 'generic', title: 'Generic' }] }) }, {
      fetchLearned: vi.fn().mockReturnValue(new Promise<LearnedReply>((r) => { release = r; })),
    });
    await openSettings();
    expect(lineOf('Packs and learned lines')).toBe('1 pack for this repository');
    await act(async () => { release({ lines: [line(1)], cap: 300 }); });
    expect(lineOf('Packs and learned lines')).toBe('1 pack for this repository · 1 line learned');
  });

  it('opens Packs and learned lines, and a removal there changes the count when Back returns to Settings, with focus on the row', async () => {
    const fetchLearned = vi.fn<(repo: string) => Promise<LearnedReply>>().mockResolvedValue(FOUR);
    const removeLearned = vi.fn().mockResolvedValue({ removed: true, note: 'Removed.' });
    show({ kind: 'ready', pr: TWO_PACKS }, { fetchLearned, removeLearned });
    await openSettings();
    await press('Packs and learned lines');
    expect(screen.getByRole('heading', { level: 2, name: 'Packs and learned lines' })).toBe(document.activeElement);
    expect(screen.getByText('Lines come from findings you dismissed. Airlock reads them in every later review of this repository.')).toBeTruthy();
    // One read for Settings and Packs together.
    expect(fetchLearned).toHaveBeenCalledTimes(1);
    fetchLearned.mockResolvedValue({ ...FOUR, lines: FOUR.lines.slice(1) });
    const generic = within(within(document.querySelector<HTMLElement>('.packs-screen')!).getByText('Generic').closest('li') as HTMLElement);
    await act(async () => { fireEvent.click(generic.getAllByRole('button', { name: 'Remove' })[0]!); });
    await act(async () => { fireEvent.click(generic.getAllByRole('button', { name: 'Remove' })[0]!); });
    await press('Back');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Packs and learned lines' }));
    expect(lineOf('Packs and learned lines')).toBe('2 packs for this repository · 3 lines learned');
  });

  it('opens Service with today\'s sections, Check again changes the Settings line too, and Back returns to the row', async () => {
    const fetchStatus = vi.fn().mockResolvedValueOnce(STATUS).mockResolvedValue({ ...STATUS, gh: false });
    show({ kind: 'ready', pr: TWO_PACKS }, { fetchStatus });
    await openSettings();
    await press('Service');
    expect(screen.getByRole('heading', { level: 2, name: 'Service' })).toBe(document.activeElement);
    for (const section of ['Service', 'Pairing', 'GitHub page']) expect(screen.getByRole('region', { name: section })).toBeTruthy();
    expect(screen.getByText('Running, version 0.2.0')).toBeTruthy();
    expect(fetchStatus).toHaveBeenCalledTimes(1);
    await press('Check again');
    expect(screen.getByText('GitHub command: not signed in')).toBeTruthy();
    await press('Back');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Service' }));
    expect(lineOf('Service')).toBe('Running · paired · Claude found · GitHub not signed in');
  });

  it('Back from Settings returns to the panel with focus on the Settings button', async () => {
    show(reviewState([finding(1)]));
    await openSettings();
    expect(document.querySelector('.kept')?.hasAttribute('inert')).toBe(true);
    await press('Back');
    expect(document.querySelector('.settings-screen')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Settings' }));
  });

  it('holds no img, a or script on Settings, Packs or Service, whatever the service sends', async () => {
    const evil = '<img src=x onerror=alert(1)><a href="https://evil.example">x</a><script>alert(1)</script>';
    show({ kind: 'ready', pr: prSummary({ packs: [{ id: 'generic', title: evil }] }) }, {
      fetchStatus: vi.fn().mockResolvedValue({ ...STATUS, version: evil, running: [{ runId: 'run_000000000001', repo: evil, number: 1 }] }),
      fetchLearned: vi.fn().mockResolvedValue({ lines: [line(1, { text: evil })], cap: 300 }),
    });
    const none = () => expect(document.querySelectorAll('img, a, script')).toHaveLength(0);
    await openSettings();
    none();
    await press('Packs and learned lines');
    expect(screen.getByText(evil, { selector: 'p' })).toBeTruthy();
    none();
    await press('Back');
    await press('Service');
    expect(screen.getByText(`Running, version ${evil}`)).toBeTruthy();
    none();
  });
});

describe('the text and button size', () => {
  it('changes the zoom at once, stores it, and the panel opens at it again after a remount', async () => {
    const store = sizeStore();
    const storage = memoryStorage();
    const size = startSize(store, { pageStorage: storage });
    const first = show({ kind: 'ready', pr: TWO_PACKS }, { size });
    await openSettings();
    const group = within(screen.getByRole('radiogroup', { name: 'Text and button size' }));
    expect((group.getByRole('radio', { name: 'Default' }) as HTMLInputElement).checked).toBe(true);
    await act(async () => { fireEvent.click(group.getByRole('radio', { name: 'Largest' })); });
    expect(document.documentElement.style.zoom).toBe('1.3');
    expect(document.documentElement.dataset.size).toBe('xl');
    expect(store.setSize).toHaveBeenCalledWith('xl');
    expect(storage.getItem('airlock.size')).toBe('xl');
    expect(screen.queryByRole('alert')).toBeNull();
    first.unmount();

    // A new panel: the hint applies before anything is drawn.
    document.documentElement.removeAttribute('style');
    const again = startSize(store, { pageStorage: storage });
    expect(document.documentElement.style.zoom).toBe('1.3');
    show({ kind: 'ready', pr: TWO_PACKS }, { size: again });
    await openSettings();
    expect((screen.getByRole('radio', { name: 'Largest' }) as HTMLInputElement).checked).toBe(true);
  });

  it('undoes a size that cannot be stored and says so', async () => {
    const store = sizeStore('l');
    store.setSize.mockRejectedValueOnce(new Error('quota'));
    const size = startSize(store, { pageStorage: memoryStorage() });
    show({ kind: 'ready', pr: TWO_PACKS }, { size });
    await act(async () => undefined);
    await openSettings();
    expect((screen.getByRole('radio', { name: 'Large' }) as HTMLInputElement).checked).toBe(true);
    await act(async () => { fireEvent.click(screen.getByRole('radio', { name: 'Small' })); });
    expect((screen.getByRole('radio', { name: 'Large' }) as HTMLInputElement).checked).toBe(true);
    expect(document.documentElement.style.zoom).toBe('1.15');
    expect(within(screen.getByRole('region', { name: 'Display' })).getByRole('alert').textContent).toBe('Airlock could not save that setting.');
  });

  it('shows Default and changes nothing when the panel is given no size', async () => {
    show({ kind: 'ready', pr: TWO_PACKS });
    await openSettings();
    fireEvent.click(screen.getByRole('radio', { name: 'Large' }));
    expect((screen.getByRole('radio', { name: 'Default' }) as HTMLInputElement).checked).toBe(true);
    expect(document.documentElement.style.zoom).toBe('');
  });
});
