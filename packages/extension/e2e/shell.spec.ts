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

test('the panel page loads and reaches the fake service without any prompt', async () => {
  let worker = context.serviceWorkers()[0];
  worker ??= await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  expect(id).toBe(EXTENSION_ID);

  const page = await context.newPage();
  const dialogs: string[] = [];
  page.on('dialog', (d) => dialogs.push(d.message()));
  await page.goto(`chrome-extension://${id}/sidepanel.html`);
  await expect(page.getByText('Airlock service: connected (version test)')).toBeVisible();

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
