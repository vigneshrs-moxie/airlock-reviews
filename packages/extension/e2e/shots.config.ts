import { defineConfig } from '@playwright/test';

// The pictures of every screen (shots.pics.ts), apart from the end-to-end suite: `npm run e2e:shots` at the repository's root
// builds the extension and runs only this.
export default defineConfig({
  testDir: '.',
  testMatch: 'shots.pics.ts',
  workers: 1,
  timeout: 300_000,
  reporter: 'list',
  outputDir: '../.playwright/shots-results',
});
