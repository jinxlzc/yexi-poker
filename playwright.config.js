import { defineConfig } from '@playwright/test';
import { tmpdir } from 'node:os';
import path from 'node:path';

export default defineConfig({
  testDir: './e2e',
  outputDir: path.join(tmpdir(), 'yexi-playwright-results'),
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 7000 },
  use: { headless: true, locale: 'zh-CN', viewport: { width: 1440, height: 900 }, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  reporter: 'list'
});
