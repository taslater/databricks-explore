// UI auditor: a crawler over the Canvas page in demo mode (its own port and data folder). Run with `npm run audit`.
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

const port = (process.env.AUDIT_PORT ??= freePort())
const dataDir = (process.env.AUDIT_DATA_DIR ??= mkdtempSync(join(tmpdir(), 'explore-audit-')))

export default defineConfig({
  testDir: '.',
  testMatch: 'audit.spec.ts',
  globalTeardown: './teardown.ts',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 55 * 60_000,
  reporter: 'list',
  outputDir: '../audit-out/pw',
  use: { baseURL: `http://127.0.0.1:${port}`, viewport: { width: 1500, height: 900 } },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1500, height: 900 } } }],
  webServer: {
    command: `uv run databricks-explore --demo --no-browser --port ${port} --data-dir "${dataDir}"`,
    cwd: '../..',
    url: `http://127.0.0.1:${port}/api/profiles`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
})
