import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const source = (path: string) => readFile(new URL(`../src/${path}`, import.meta.url), 'utf8');

describe('action policy module boundaries', () => {
  it('keeps provider adapters and UI free of policy decisions', async () => {
    const [providerContract, xAdapter, uiScript] = await Promise.all([
      source('modules/providers/contract.ts'),
      source('modules/providers/x-adapter.ts'),
      source('ui/workflow.tsx'),
    ]);
    for (const content of [providerContract, xAdapter, uiScript]) {
      expect(content).not.toMatch(/ActionPolicy|actionPolicy|commercial|quota|tier/);
    }
  });

  it('threads the injected policy into every registered mutation boundary', async () => {
    const application = await source('application/create-application.ts');
    expect(application).toContain('registerPostRoutes(');
    expect(application).toContain('registerMediaRoutes(');
    expect(application).toContain('registerBrowserWorkflowRoutes(application, { auth, database, actionPolicy })');
    expect(application).toContain('registerXOauthRoutes(application, { auth, database, actionPolicy, ...xOauth })');
  });
});
