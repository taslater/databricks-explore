// UI auditor: a crawler over the Canvas page in demo mode. One test per (root, viewport), run in parallel; each worker starts its own demo
// server (port and data folder) from a worker-scoped fixture. Run with `npm run audit`; AUDIT_WORKERS sets the worker count.
import { cpus } from 'node:os'
import { defineConfig, devices } from '@playwright/test'

const workers = (process.env.AUDIT_WORKERS ??= String(Math.max(1, Math.min(10, cpus().length))))

export default defineConfig({
  testDir: '.',
  testMatch: 'audit.spec.ts',
  globalSetup: './setup.ts',
  globalTeardown: './teardown.ts',
  workers: Number(workers),
  fullyParallel: true,
  retries: 0,
  timeout: 30 * 60_000,
  reporter: 'list',
  outputDir: '../audit-out/pw',
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1500, height: 900 } } }],
})
