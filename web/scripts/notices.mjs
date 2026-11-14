// Writes THIRD-PARTY-NOTICES.txt next to the built UI: name, version, license and copyright text of every
// production npm package (package-lock.json entries that are not dev-only). Run by `npm run build` after vite.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const web = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(web, '..', 'src', 'databricks_explore', 'web_dist', 'THIRD-PARTY-NOTICES.txt')
const lock = JSON.parse(readFileSync(join(web, 'package-lock.json'), 'utf8'))

const licenseOf = (pkg) => {
  if (typeof pkg.license === 'string') return pkg.license
  if (pkg.license?.type) return pkg.license.type
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map((l) => l.type ?? l).join(' OR ')
  return 'UNKNOWN'
}

const entries = []
for (const [key, info] of Object.entries(lock.packages)) {
  if (!key.startsWith('node_modules/') || info.dev) continue
  const dir = join(web, key)
  if (!existsSync(join(dir, 'package.json'))) continue // an optional package for another platform
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const files = readdirSync(dir).filter((f) => /^(licen[cs]e|copying|notice)(\.|$|-)/i.test(f)).sort()
  const texts = files.map((f) => readFileSync(join(dir, f), 'utf8').trim())
  const author = typeof pkg.author === 'string' ? pkg.author : pkg.author?.name
  entries.push({
    name: pkg.name,
    version: pkg.version,
    license: licenseOf(pkg),
    text: texts.length ? texts.join('\n\n') : `(no license file in the package; package.json author: ${author ?? "not given"}, repository: ${typeof pkg.repository === "string" ? pkg.repository : (pkg.repository?.url ?? "not given")})`,
  })
}
entries.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))

const bar = '='.repeat(78)
const parts = [
  'THIRD-PARTY NOTICES',
  '',
  'The web UI bundles the npm packages below (production dependencies only, from package-lock.json).',
  'Each entry gives the package, its version, its license and the license and copyright text it ships.',
  `${entries.length} packages.`,
  '',
]
for (const e of entries) parts.push(bar, `${e.name} ${e.version}`, `License: ${e.license}`, '', e.text, '')
writeFileSync(out, parts.join('\n'), 'utf8')
console.log(`wrote ${entries.length} notices to ${out}`)
