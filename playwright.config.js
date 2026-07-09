import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test/e2e',
  fullyParallel: true,
  webServer: {
    command: 'python3 -m http.server 8934 --directory src',
    port: 8934,
    reuseExistingServer: true,
  },
  use: {
    baseURL: 'http://localhost:8934',
    hasTouch: true,
  },
});
