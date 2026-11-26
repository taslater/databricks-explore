// Empties the output folder, checks expected.json before any crawl starts and records the start time for the merge.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadExpected } from './report'

export default function setup() {
  const out = fileURLToPath(new URL('../audit-out', import.meta.url))
  loadExpected()
  for (const d of ['parts', 'screens']) rmSync(join(out, d), { recursive: true, force: true })
  rmSync(join(out, 'ui-findings.json'), { force: true })
  rmSync(join(out, 'graph.json'), { force: true })
  mkdirSync(join(out, 'screens'), { recursive: true })
  writeFileSync(join(out, '.started'), String(Date.now()))
}
