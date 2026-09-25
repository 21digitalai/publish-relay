import { defineConfig } from '@playwright/test';

const magicLinkSuite = process.argv.some((argument) => argument.includes('magic-link.spec'));

export default defineConfig({
  testDir: './tests/e2e',
  testIgnore: magicLinkSuite ? [] : ['**/magic-link.spec.ts'],
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:43199' },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 900 } } },
    { name: 'mobile', use: { viewport: { width: 390, height: 844 } } },
  ],
  webServer: [
    {
      command: 'npm run build && npx tsx tests/e2e/server.ts',
      env: { PUBLISH_RELAY_HUMAN_AUTH_MODE: magicLinkSuite ? 'magic_link' : 'password' },
      port: 43199,
      reuseExistingServer: false,
    },
  ],
});
