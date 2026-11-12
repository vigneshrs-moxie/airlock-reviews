// Renders brand/logo.svg to the PNG sizes Chrome asks for, into public/icon/. Run: npm run icons -w @airlock/extension
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const svg = await readFile(here('../brand/logo.svg'), 'utf8');
await mkdir(here('../public/icon'), { recursive: true });

const browser = await chromium.launch();
try {
  for (const size of [16, 32, 48, 128]) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
    await page.screenshot({ path: here(`../public/icon/${size}.png`), omitBackground: true });
    await page.close();
  }
} finally {
  await browser.close();
}
