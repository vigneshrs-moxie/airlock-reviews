import { chromium, expect, test, type BrowserContext } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeService, type FakeService } from './fake-service';

// Written in wxt.config.ts next to the key it comes from.
const EXTENSION_ID = 'nbcmjckbkploiemllhkmhegjimgeimoa';
const BUILT = fileURLToPath(new URL('../.output-e2e/chrome-mv3', import.meta.url));

let service: FakeService;
let profile: string;
let context: BrowserContext;

test.beforeAll(async () => {
  service = await startFakeService();
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

test('the panel, beside a pull request tab, reaches the fake service and asks for pairing', async () => {
  let worker = context.serviceWorkers()[0];
  worker ??= await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  expect(id).toBe(EXTENSION_ID);

  // A stubbed pull request page, made the active tab by the extension's own service worker.
  await context.route('https://github.com/acme/widgets/pull/1', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>stub</title><p>stub</p>' }));
  const github = await context.newPage();
  await github.goto('https://github.com/acme/widgets/pull/1');
  await worker.evaluate(async () => {
    const chrome = (globalThis as unknown as { chrome: typeof browser }).chrome;
    const [tab] = await chrome.tabs.query({ url: 'https://github.com/acme/widgets/pull/1' });
    if (tab?.id === undefined) throw new Error('the pull request tab was not found');
    await chrome.tabs.update(tab.id, { active: true });
  });

  const page = await context.newPage();
  const dialogs: string[] = [];
  page.on('dialog', (d) => dialogs.push(d.message()));
  await page.goto(`chrome-extension://${id}/sidepanel.html`);
  await github.bringToFront();
  await worker.evaluate(async () => {
    const chrome = (globalThis as unknown as { chrome: typeof browser }).chrome;
    const [tab] = await chrome.tabs.query({ url: 'https://github.com/acme/widgets/pull/1' });
    if (tab?.id !== undefined) await chrome.tabs.update(tab.id, { active: true });
  });
  service.requests.length = 0;
  await page.reload();
  await expect(page.getByText('Not paired')).toBeVisible();
  await expect(page.getByLabel('Pairing token')).toBeVisible();

  expect(dialogs).toEqual([]);
  expect(service.requests.some((r) => r.method === 'GET' && r.url === '/hello')).toBe(true);
});

test('the manifest asks only for sidePanel, storage, github.com and 127.0.0.1', async () => {
  const manifest = JSON.parse(await readFile(join(BUILT, 'manifest.json'), 'utf8')) as Record<string, unknown>;
  expect(manifest.permissions).toEqual(['sidePanel', 'storage']);
  expect(manifest.host_permissions).toEqual(['https://github.com/*', 'http://127.0.0.1/*']);
  for (const key of ['optional_permissions', 'optional_host_permissions', 'externally_connectable']) {
    expect(manifest).not.toHaveProperty(key);
  }
  const everything = JSON.stringify(manifest);
  for (const banned of ['"tabs"', '"scripting"', '"activeTab"', '<all_urls>']) {
    expect(everything).not.toContain(banned);
  }
  const csp = manifest.content_security_policy as { extension_pages?: string } | string | undefined;
  if (csp !== undefined) {
    const text = typeof csp === 'string' ? csp : (csp.extension_pages ?? '');
    expect(text).not.toMatch(/https?:|\*|unsafe-eval|unsafe-inline/);
  }
  expect(manifest.minimum_chrome_version).toBe('116');
  expect(typeof manifest.key).toBe('string');
  expect(manifest).not.toHaveProperty('web_accessible_resources');
  expect(manifest.side_panel).toEqual({ default_path: 'sidepanel.html' });
  expect(manifest.action).not.toHaveProperty('default_popup');
  const scripts = manifest.content_scripts as { matches: string[]; run_at: string; world?: string }[];
  expect(scripts).toHaveLength(1);
  expect(scripts[0]?.matches).toEqual(['https://github.com/*']);
  expect(scripts[0]?.run_at).toBe('document_idle');
  expect(['ISOLATED', undefined]).toContain(scripts[0]?.world);
});
