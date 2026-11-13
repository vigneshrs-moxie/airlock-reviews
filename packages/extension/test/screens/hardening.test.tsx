// @vitest-environment happy-dom
import { createHmac } from 'node:crypto';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SERVICE_URL } from '../../src/config';
import { App, startRealPanel } from '../../src/panel/App';
import { BriefBlock } from '../../src/screens/BriefBlock';
import { CommandBox } from '../../src/screens/CommandBox';
import { PanelScreen } from '../../src/screens/PanelScreen';
import type { PanelDeps, PanelState, UserAction } from '../../src/state/machine';
import type { SettingsStore } from '../../src/state/settings';
import type { TabWatcher } from '../../src/state/tab';
import { FakeTimers } from '../helpers/fake-timers';
import { brief, latestFor, map, prSummary } from './fixtures';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const noop = (): void => undefined;
const evil = '<img src=x onerror=alert(1)><script>alert(1)</script>';
const js = '[click](javascript:alert(1))';

function noMarkup(): void {
  for (const tag of ['script', 'a', 'img']) expect(document.querySelector(tag), tag).toBeNull();
}

describe('App in StrictMode', () => {
  function counting() {
    const live = new Set<number>();
    const emits: ((s: PanelState) => void)[] = [];
    let n = 0;
    const start = (onState: (s: PanelState) => void) => {
      const id = n++;
      live.add(id);
      emits.push(onState);
      return { dispatch: (_a: UserAction) => undefined, stop: () => { live.delete(id); } };
    };
    return { live, emits, start };
  }
  it('leaves exactly one running panel after mount and none after unmount', () => {
    const c = counting();
    const view = render(<StrictMode><App start={c.start} /></StrictMode>);
    expect(c.live.size).toBe(1);
    view.unmount();
    expect(c.live.size).toBe(0);
  });
  it('ignores a state from a panel that was stopped, and one arriving after unmount', () => {
    const c = counting();
    const view = render(<StrictMode><App start={c.start} /></StrictMode>);
    expect(c.emits.length).toBe(2);
    act(() => c.emits[0]?.({ kind: 'offline' }));
    expect(screen.getByText('Looking at this pull request…')).toBeTruthy();
    act(() => c.emits[1]?.({ kind: 'offline' }));
    expect(screen.getByText('Not running')).toBeTruthy();
    view.unmount();
    const spy = vi.spyOn(console, 'error').mockImplementation(noop);
    act(() => c.emits[1]?.({ kind: 'unpaired' }));
    expect(spy).not.toHaveBeenCalled();
    expect(document.body.textContent).toBe('');
    spy.mockRestore();
  });
});

describe('the real construction', () => {
  it('gives the client SERVICE_URL and the settings store token reader', async () => {
    const settings: SettingsStore = {
      getToken: async () => 'tok-123', setToken: async () => undefined,
      getDefaultDepth: async () => null, setDefaultDepth: async () => undefined,
      getShowNotes: async () => true, setShowNotes: async () => undefined,
      getSize: async () => 'm', setSize: async () => undefined, getTourSeen: async () => true, setTourSeen: async () => undefined,
    };
    const tab: TabWatcher = { current: async () => ({ tabId: 1, url: undefined }), onChange: () => noop };
    let seen: PanelDeps | undefined;
    const stop = vi.fn();
    // The client asks /hello with a nonce first and sends the token only once the proof matches it.
    const fetchSpy = vi.fn(async (input: string) => {
      const nonce = new URL(input).searchParams.get('nonce');
      if (new URL(input).pathname !== '/hello' || nonce === null) return new Response('{}', { status: 500 });
      // The proof names the port of SERVICE_URL, the address the real construction connects to.
      const proof = createHmac('sha256', 'tok-123').update(`airlock-hello:${new URL(SERVICE_URL).port}:${nonce}`).digest('hex');
      return new Response(JSON.stringify({ airlock: true, version: '1.0.0', paired: true, proof }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchSpy);
    const panel = startRealPanel(noop, { settings, tab }, (deps) => { seen = deps; return { dispatch: noop, stop }; });
    expect(panel.stop).toBe(stop);
    expect(seen?.settings).toBe(settings);
    expect(seen?.tab).toBe(tab);
    await seen?.client.pr('acme/widgets', 1).catch(() => undefined);
    const [hello, asked] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit | undefined];
    expect(hello.startsWith(`${SERVICE_URL}/hello?nonce=`)).toBe(true);
    expect(new Headers(asked?.headers).has('authorization')).toBe(false);
    const [url, init] = fetchSpy.mock.calls[1] as unknown as [string, RequestInit];
    expect(url.startsWith(`${SERVICE_URL}/pr?`)).toBe(true);
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok-123');
  });
});

describe('ready keeps its choices', () => {
  it('a notice re-render keeps a changed depth and a switched-off pack', () => {
    const pr = prSummary({ packs: [{ id: 'orbit', title: 'Orbit' }, { id: 'generic', title: 'Generic' }] });
    const dispatch = vi.fn();
    const { rerender } = render(<PanelScreen state={{ kind: 'ready', pr }} dispatch={dispatch} onOpenSettings={noop} />);
    fireEvent.click(screen.getByRole('radio', { name: /Deep/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Packs' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Orbit' }));
    rerender(<PanelScreen state={{ kind: 'ready', pr, notice: 'Refused.' }} dispatch={dispatch} onOpenSettings={noop} />);
    expect((screen.getByRole('radio', { name: /Deep/ }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('switch', { name: 'Orbit' }) as HTMLInputElement).checked).toBe(false);
  });
});

describe('pairing', () => {
  it('a failed pairing shows the message and the field stays empty', () => {
    const dispatch = vi.fn();
    const { rerender } = render(<PanelScreen state={{ kind: 'unpaired' }} dispatch={dispatch} onOpenSettings={noop} />);
    const field = screen.getByLabelText('Pairing token') as HTMLInputElement;
    fireEvent.change(field, { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: 'Pair' }));
    rerender(<PanelScreen state={{ kind: 'unpaired', message: 'That token was refused.' }} dispatch={dispatch} onOpenSettings={noop} />);
    expect(screen.getByText('That token was refused.')).toBeTruthy();
    expect((screen.getByLabelText('Pairing token') as HTMLInputElement).value).toBe('');
  });
});

describe('command box', () => {
  it('says Copied for two seconds, announces it, then says Copy again', async () => {
    const timers = new FakeTimers();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn().mockResolvedValue(undefined) }, configurable: true });
    render(<PanelScreen state={{ kind: 'offline' }} dispatch={noop} onOpenSettings={noop} timers={timers} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await screen.findByRole('button', { name: 'Copied' });
    expect(timers.delays()).toContain(2000);
    expect(document.querySelector('[aria-live="polite"]')?.textContent).toContain('Copied');
    act(() => timers.fire());
    expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy();
  });
  it('selects the text when navigator.clipboard is missing', () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    render(<CommandBox intro="Run:" command="npm run service" />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(window.getSelection()?.toString()).toContain('npm run service');
  });
});

describe('brief block', () => {
  it('renders nothing for an empty brief and no heading over an empty list', () => {
    const { container } = render(<BriefBlock brief={{ whatItDoes: [], claims: [] }} />);
    expect(container.textContent).toBe('');
    cleanup();
    render(<BriefBlock brief={{ whatItDoes: ['One.'], claims: [{ text: 'T', verdict: 'verified', evidence: 'e' }] }} />);
    expect(screen.queryByRole('heading', { name: 'Claims to check' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'What this does' })).toBeTruthy();
  });
  it('shows a claim with no evidence as its verdict word alone', () => {
    render(<BriefBlock brief={{ whatItDoes: [], claims: [{ text: 'T', verdict: 'unclear', evidence: '' }] }} />);
    const line = screen.getByText('Unclear').parentElement;
    expect(line?.textContent).toBe('Unclear');
  });
  it('an offline state with a brief and a map shows both', () => {
    render(<PanelScreen state={{ kind: 'offline', progress: { pr: prSummary(), brief, map, startedAt: 1 } }} dispatch={noop} onOpenSettings={noop} />);
    expect(screen.getByRole('heading', { name: 'What this does' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Read in this order' })).toBeTruthy();
  });
});

describe('markup-looking text from the state', () => {
  const pr = prSummary({ title: evil, packs: [{ id: 'orbit', title: evil }] });
  it('on Ready: title, pack title and notice', () => {
    render(<PanelScreen state={{ kind: 'ready', pr, notice: js }} dispatch={noop} onOpenSettings={noop} />);
    expect(screen.getAllByText(evil).length).toBe(2);
    expect(screen.getByText(js)).toBeTruthy();
    noMarkup();
  });
  it('on Pair', () => {
    render(<PanelScreen state={{ kind: 'unpaired', message: evil }} dispatch={noop} onOpenSettings={noop} />);
    expect(screen.getByText(evil)).toBeTruthy();
    noMarkup();
  });
  it('on Problem', () => {
    render(<PanelScreen state={{ kind: 'problem', pr, message: js }} dispatch={noop} onOpenSettings={noop} />);
    expect(screen.getByText(js)).toBeTruthy();
    noMarkup();
  });
  it('on Offline, in the kept brief and map', () => {
    const b = { whatItDoes: [evil], claims: [{ text: js, verdict: 'unclear' as const, evidence: js }] };
    const m = { cohorts: [{ id: 'c', title: evil, summary: '', neighbours: [], inferredLinks: [], layers: [{ id: 'l', title: js, kind: 'data' as const, files: [evil], dependsOn: [], note: '' }] }], standalone: [], links: [] };
    render(<PanelScreen state={{ kind: 'offline', progress: { pr, brief: b, map: m, startedAt: null } }} dispatch={noop} onOpenSettings={noop} />);
    expect(screen.getAllByText(evil).length).toBeGreaterThan(0);
    noMarkup();
  });
});
