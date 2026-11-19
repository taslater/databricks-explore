// End-to-end tests: Chromium against the real app in demo mode, on a free port and a temporary data folder.
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig, devices } from '@playwright/test'

/** A port nothing is listening on, found by asking the operating system. */
function freePort(): string {
  const script = "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"
  return execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' }).trim()
}

// Workers load this file again; the environment (inherited from this process) keeps them on the same port and folder.
const port = (process.env.E2E_PORT ??= freePort())
const dataDir = (process.env.E2E_DATA_DIR ??= mkdtempSync(join(tmpdir(), 'explore-e2e-')))

export default defineConfig({
  testDir: './e2e',
  globalTeardown: './e2e/teardown.ts',
  // One server and one data folder are shared, so the tests run one after another.
  workers: 1,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1500, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1500, height: 900 } } }],
  webServer: {
    // Run after `npm run build` (the e2e script does): the app serves the build in src/databricks_explore/web_dist.
    command: `uv run databricks-explore --demo --no-browser --port ${port} --data-dir "${dataDir}"`,
    cwd: '..',
    url: `http://127.0.0.1:${port}/api/profiles`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
})
