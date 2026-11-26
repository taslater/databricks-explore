// Merges the per-crawl results into ui-findings.json and graph.json once every crawl has finished.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mergeParts } from './report'

export default function teardown() {
  const out = fileURLToPath(new URL('../audit-out', import.meta.url))
  const started = Number(readFileSync(join(out, '.started'), 'utf8'))
  mergeParts(out, Math.round((Date.now() - started) / 1000), Number(process.env.AUDIT_WORKERS ?? 0))
}
