import { expect, test } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 43209;
const ORIGIN = `http://127.0.0.1:${String(PORT)}`;

async function waitForServer(child: ChildProcess, output: () => string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null)
      throw new Error(`E2E server exited before readiness:\n${output()}`);
    try {
      const response = await fetch(`${ORIGIN}/health/live`);
      if (response.ok) return;
    } catch {
      // The child is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`E2E server did not become ready:\n${output()}`);
}

async function startServer(databaseDir: string, enabledAdapters: string): Promise<ChildProcess> {
  let output = '';
  const child = spawn('npx', ['tsx', 'tests/e2e/server.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PUBLISH_RELAY_E2E_PORT: String(PORT),
      PUBLISH_RELAY_E2E_DATABASE_DIR: databaseDir,
      PUBLISH_RELAY_ENABLED_ADAPTERS: enabledAdapters,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => {
    output += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    output += String(chunk);
  });
  await waitForServer(child, () => output);
  return child;
}

async function stopServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) =>
    child.once('exit', () => {
      resolve();
    }),
  );
  child.kill('SIGTERM');
  await exited;
}

test('existing adapter history survives a persistent-database disable and restart', async ({
  browser,
}, testInfo) => {
  const databaseDir = await mkdtemp(join(tmpdir(), 'publish-relay-adapter-restart-'));
  let server: ChildProcess | undefined;
  try {
    server = await startServer(databaseDir, 'x');
    const enabledContext = await browser.newContext({ baseURL: ORIGIN });
    const enabledPage = await enabledContext.newPage();
    const suffix = `${String(Date.now())}-${Math.random().toString(36).slice(2)}`;
    const email = `adapter-policy-${suffix}@example.test`;
    const password = 'long-password-123!';
    const registration = await enabledPage.request.post('/api/auth/register', {
      data: {
        displayName: 'Adapter Policy Owner',
        email,
        password,
        workspaceName: `Adapter Policy ${suffix}`,
      },
    });
    expect(registration.ok()).toBe(true);
    const seed = await enabledPage.request.post('/__test__/seed-disabled-adapter-history');
    const seeded = (await seed.json()) as { data: { jobId: string }; error?: string };
    expect(seed.ok(), JSON.stringify(seeded)).toBe(true);
    await enabledContext.close();
    await stopServer(server);
    server = undefined;

    server = await startServer(databaseDir, '');
    const disabledContext = await browser.newContext({ baseURL: ORIGIN });
    const page = await disabledContext.newPage();
    const login = await page.request.post('/api/auth/login', { data: { email, password } });
    expect(login.ok()).toBe(true);
    const workspace = (await (await page.request.get('/api/workspaces/current')).json()) as {
      data: { slug: string };
    };
    const preserved = await page.request.get(`/api/workflow/jobs/${seeded.data.jobId}`);
    expect(preserved.ok()).toBe(true);
    const disabledRoute = await page.request.post('/api/oauth/fanvue');
    expect(disabledRoute.status()).toBe(404);

    await page.goto(`/w/${workspace.data.slug}/queue`);
    await page.getByRole('button', { name: 'Needs attention', exact: true }).click();
    await page.locator('.queue-row').click();
    await expect(page.getByRole('heading', { name: 'Existing X account' })).toBeVisible();
    await expect(
      page.getByRole('status').filter({ hasText: 'This adapter is disabled on this server' }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Record verified failure' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Retry now' })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('disabled-existing-adapter-history.png') });
    await disabledContext.close();
  } finally {
    if (server) await stopServer(server);
    await rm(databaseDir, { recursive: true, force: true });
  }
});
