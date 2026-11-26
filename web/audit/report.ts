// The parts of the auditor shared by the crawl tests and the final merge: severities, expected.json, and the report built from per-crawl results.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const SEVERITY: Record<string, 'high' | 'medium' | 'low' | 'info'> = {
  'irreversible-transition': 'high',
  'toggle-not-undoable': 'high',
  'occluded-control': 'high',
  'only-obscure-exit': 'medium',
  'offscreen-control': 'medium',
  'overlapping-controls': 'medium',
  'escape-does-nothing': 'low',
  'clipped-text': 'low',
  'small-target': 'info',
}
export const WEIGHT = { high: 10, medium: 4, low: 1, info: 0 }
export const LOW_CONFIDENCE_FACTOR = 0.25 // a finding the rule labels low-confidence counts a quarter of its weight
export const LOW_CONFIDENCE_CAP = 15 // and all of them together never weigh more than this

export type Where = { root: string; viewport: string; stateId: string }
export type Finding = {
  ruleId: string
  severity: string
  control: string
  detail: string
  occluder?: string
  screenshot: string
  repro: string[]
  confidence: 'high' | 'low' // low: the rule itself says the evidence is incomplete or heuristic
  where: Where[]
}

// ---- expected.json: by-design findings, a maintainer's decision. They stay in the report, marked expected, and do not count toward the score. ----
export type Expected = { rule: string; control: RegExp | string; root?: string; viewport?: string; reason: string; raw: unknown }
export function loadExpected(): Expected[] {
  const file = fileURLToPath(new URL('./expected.json', import.meta.url))
  if (!existsSync(file)) return []
  const bad = (i: number, why: string) => new Error('audit/expected.json entry ' + i + ': ' + why)
  const data: unknown = JSON.parse(readFileSync(file, 'utf8'))
  if (!Array.isArray(data)) throw new Error('audit/expected.json must be an array of entries')
  return data.map((raw, i) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw bad(i, 'not an object')
    const e = raw as Record<string, unknown>
    for (const k of Object.keys(e)) if (!['rule', 'control', 'root', 'viewport', 'reason'].includes(k)) throw bad(i, 'unknown key "' + k + '"')
    if (typeof e.rule !== 'string' || !(e.rule in SEVERITY)) throw bad(i, 'rule must be one of ' + Object.keys(SEVERITY).join(', '))
    if (typeof e.control !== 'string' || !e.control.trim()) throw bad(i, 'control must be a non-empty string or /regex/')
    if (typeof e.reason !== 'string' || !e.reason.trim()) throw bad(i, 'reason is required and must not be empty')
    for (const k of ['root', 'viewport'] as const) if (e[k] !== undefined && (typeof e[k] !== 'string' || !(e[k] as string).trim())) throw bad(i, k + ' must be a non-empty string')
    let control: RegExp | string = e.control
    const m = /^\/(.+)\/([a-z]*)$/.exec(e.control)
    if (m) {
      try {
        control = new RegExp(m[1], m[2])
      } catch {
        throw bad(i, 'control is not a valid regular expression')
      }
    }
    return { rule: e.rule, control, root: e.root as string | undefined, viewport: e.viewport as string | undefined, reason: e.reason, raw }
  })
}
const nameOf = (label: string) => /"(.*)"/.exec(label)?.[1] ?? label
/** A string control equals the control's name (or its whole label); a regex is tested against both. irreversible-transition also matches the first click of the repro, because one one-way action shows up under every state it leads to. */
export function expectedMatches(x: Expected, f: Finding): boolean {
  const names = [f.control, nameOf(f.control)]
  if (f.ruleId === 'irreversible-transition' && f.repro[1]) names.push(f.repro[1], nameOf(f.repro[1]))
  const hit = names.some((n) => (typeof x.control === 'string' ? n === x.control : x.control.test(n)))
  return hit && x.rule === f.ruleId && f.where.some((w) => (!x.root || w.root === x.root) && (!x.viewport || w.viewport === x.viewport))
}


/** What one crawl leaves for the merge: its findings in discovery order, its summary row and its graph. */
export type Part = { order: number; findings: [string, Finding][]; crawl: Record<string, unknown>; graph: Record<string, unknown> }

/** Merges the parts of all crawls, in crawl order, into ui-findings.json and graph.json. Same dedupe, same scoring as one serial run. */
export function mergeParts(OUT: string, wallSeconds: number, workers: number) {
  const expectedList = loadExpected()
  const dir = join(OUT, 'parts')
  const parts: Part[] = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8'))) : []
  parts.sort((a, b) => a.order - b.order)
  const findings = new Map<string, Finding>()
  const crawls: Record<string, unknown>[] = []
  const graphs: Record<string, unknown>[] = []
  for (const p of parts) {
    crawls.push(p.crawl)
    graphs.push(p.graph)
    for (const [k, f] of p.findings) {
      const have = findings.get(k)
      if (!have) findings.set(k, f)
      else for (const w of f.where) if (!have.where.some((x) => x.root === w.root && x.viewport === w.viewport)) have.where.push(w)
    }
  }
  const list = [...findings.values()].map((f) => ({ ...f, seenIn: f.where.length, expected: false as boolean, expectedReason: undefined as string | undefined }))
  const used = new Set<number>()
  for (const f of list) {
    const i = expectedList.findIndex((x) => expectedMatches(x, f))
    if (i < 0) continue
    f.expected = true
    f.expectedReason = expectedList[i].reason
    used.add(i)
  }
  const staleExpected = expectedList.filter((_, i) => !used.has(i)).map((x) => x.raw)
  const order = { high: 0, medium: 1, low: 2, info: 3 } as Record<string, number>
  list.sort((a, b) => order[a.severity] - order[b.severity] || b.seenIn - a.seenIn)
  const counted = list.filter((f) => !f.expected)
  const byRule: Record<string, number> = {}
  const expectedByRule: Record<string, number> = {}
  for (const f of list) {
    const m = f.expected ? expectedByRule : byRule
    m[f.ruleId] = (m[f.ruleId] ?? 0) + 1
  }
  // Root causes: occluded and overlapping findings grouped by what sits on top, biggest first.
  const groups = new Map<string, { occluder: string; count: number; byRule: Record<string, number>; roots: Set<string>; examples: string[]; repro: string[]; screenshot: string; severity: string }>()
  for (const f of counted) {
    if (!f.occluder) continue
    const g = groups.get(f.occluder) ?? { occluder: f.occluder, count: 0, byRule: {}, roots: new Set<string>(), examples: [], repro: f.repro, screenshot: f.screenshot, severity: f.severity }
    g.count++
    g.byRule[f.ruleId] = (g.byRule[f.ruleId] ?? 0) + 1
    if (order[f.severity] < order[g.severity]) g.severity = f.severity
    f.where.forEach((w) => g.roots.add(w.root))
    if (g.examples.length < 5 && !g.examples.includes(f.control)) g.examples.push(f.control)
    groups.set(f.occluder, g)
  }
  const rootCauses = [...groups.values()].sort((a, b) => b.count - a.count).map(({ severity, ...g }) => ({ ...g, roots: [...g.roots] }))
  // Score: each distinct root cause counts once (a group of findings under one occluder is one cause), weighted by severity.
  // Findings the rule labels low-confidence count a quarter, and together at most LOW_CONFIDENCE_CAP, so a pile of uncertain ones cannot pin the score.
  let total = 0
  let lowRaw = 0
  for (const f of counted)
    if (!f.occluder) {
      const w = WEIGHT[f.severity as keyof typeof WEIGHT]
      if (f.confidence === 'low') lowRaw += w * LOW_CONFIDENCE_FACTOR
      else total += w
    }
  for (const g of groups.values()) total += WEIGHT[g.severity as keyof typeof WEIGHT]
  const lowCounted = Math.min(lowRaw, LOW_CONFIDENCE_CAP)
  total += lowCounted
  const score = Math.round(100 * Math.exp(-total / 50))
  const summary = {
    crawls: crawls.length, score, weightedCauses: total, lowConfidenceFindings: counted.filter((f) => f.confidence === 'low').length, lowConfidenceWeight: lowCounted, findingsByRule: byRule, expectedByRule, staleExpected, rootCauses, perCrawl: crawls,
    states: crawls.reduce((n, c) => n + (c.states as number), 0), actions: crawls.reduce((n, c) => n + (c.actions as number), 0),
    timing: (() => {
      const sum: Record<string, number> = {}
      for (const c of crawls) for (const [k, v] of Object.entries(c.timing as Record<string, number>)) sum[k] = (sum[k] ?? 0) + v
      return sum
    })(),
    unverifiedReturns: crawls.reduce((n, c) => n + (c.unverifiedReturns as number), 0), seconds: wallSeconds, workers,
  }
  writeFileSync(join(OUT, 'ui-findings.json'), JSON.stringify({ summary, findings: list }, null, 2))
  writeFileSync(join(OUT, 'graph.json'), JSON.stringify(graphs, null, 2))
  console.log('audit: ' + summary.crawls + ' crawls, ' + list.length + ' findings (' + JSON.stringify(byRule) + ', expected ' + JSON.stringify(expectedByRule) + ', stale ' + staleExpected.length + '), score ' + score + ', ' + summary.seconds + 's')
  return summary
}
