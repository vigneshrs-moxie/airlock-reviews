import { chromium, expect, test, type BrowserContext, type Worker } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeService, type FakeService } from './fake-service';

// Something else answers on Airlock's port, speaking its contract but holding another token: the panel must show the
// sentence and never hand it the token, whether the token was just pasted or was stored by an earlier pairing.
const EXTENSION_ID = 'nbcmjckbkploiemllhkmhegjimgeimoa';
const BUILT = fileURLToPath(new URL('../.output-e2e/chrome-mv3', import.meta.url));
const TOKEN = '0123456789abcdef'.repeat(4);
const PR_URL = 'https://github.com/acme/widgets/pull/1';
const NOT_PROVED = "Something else is answering on Airlock's port. The token was not sent.";

let service: FakeService;
let profile: string;
let context: BrowserContext;

test.beforeAll(async () => {
  service = await startFakeService({ token: TOKEN, proofKey: 'f'.repeat(64) });
  profile = await mkdtemp(join(tmpdir(), 'airlock-e2e-'));
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${BUILT}`, `--load-extension=${BUILT}`],
  });
});

test.afterAll(async () => {
  await context?.close();
  await service?.close();
  if (profile) await rm(profile, { recursive: true, force: true });
});

async function activate(worker: Worker): Promise<void> {
  await worker.evaluate(async (address) => {
    const chrome = (globalThis as unknown as { chrome: typeof browser }).chrome;
    const [tab] = await chrome.tabs.query({ url: address });
    if (tab?.id === undefined) throw new Error(`no tab at ${address}`);
    await chrome.tabs.update(tab.id, { active: true });
  }, PR_URL);
}

test('a service that cannot prove it holds the token gets the sentence and never an Authorization header', async () => {
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  await context.route(PR_URL, (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>stub</title><p>stub</p>' }));
  const github = await context.newPage();
  await github.goto(PR_URL);
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${EXTENSION_ID}/sidepanel.html`);
  await github.bringToFront();
  await activate(worker);
  await panel.reload();

  // Pasting the token: it is checked against the proof before /pair, and not sent.
  await expect(panel.getByLabel('Pairing token')).toBeVisible();
  await panel.getByLabel('Pairing token').fill(TOKEN);
  await panel.getByRole('button', { name: 'Pair' }).click();
  await expect(panel.getByText(NOT_PROVED)).toBeVisible();

  // A token stored by an earlier pairing: the panel's first hello finds no matching proof, and sends nothing with it.
  await worker.evaluate(async (token) => {
    const chrome = (globalThis as unknown as { chrome: typeof browser }).chrome;
    await chrome.storage.local.set({ 'airlock.token': token });
  }, TOKEN);
  const before = service.requests.length;
  await panel.reload();
  await expect(panel.getByText(NOT_PROVED)).toBeVisible();
  const hellos = service.requests.slice(before).filter((r) => r.method === 'GET' && r.url.startsWith('/hello?nonce='));
  expect(hellos.length).toBeGreaterThan(0);

  expect(service.requests.length).toBeGreaterThan(0);
  expect(service.requests.filter((r) => r.headers.authorization !== undefined)).toEqual([]);
  expect(service.requests.filter((r) => r.method === 'POST' && r.url === '/pair')).toEqual([]);
  expect(service.problems).toEqual([]);
});
