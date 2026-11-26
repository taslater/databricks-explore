// A deterministic UI auditor: crawls the Canvas page in demo mode (BFS over clicks and Escape, replaying from a clean start)
// and reports generic defects (irreversible transitions, occluded or tiny controls, overlaps, clipped text). No LLM, no feature knowledge.
// It is a reporter, not a gate: the test passes whatever it finds. Output: web/audit-out/ui-findings.json, graph.json, screens/.
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { start } from '../e2e/helpers'

const OUT = fileURLToPath(new URL('../audit-out', import.meta.url))
const DENY = /export|download|save as|copy|png|svg|open in|databricks|github/i
const ONE_WAY = /delete|remove|close|clear/i
const MAX_DEPTH = 3
const MAX_STATES = 60
const MAX_ACTIONS = 400
const PER_STATE_RETURN_TRIES = 16 // actions tried in B when looking for a way back
const PHASE2_STATE_CAP = 80
const RETURN_WORDS = /delete|remove|close|clear|hide|undo|cancel|back|restore|dismiss|reset|minimi|collapse|toggle/i
const EXTRA_ACTIONS = 260 // budget for the explicit return attempts after the crawl
const SEVERITY: Record<string, 'high' | 'medium' | 'low'> = {
  'irreversible-transition': 'high',
  'occluded-control': 'high',
  'offscreen-control': 'medium',
  'overlapping-controls': 'medium',
  'escape-does-nothing': 'low',
  'small-target': 'low',
  'clipped-text': 'low',
}
const WEIGHT = { high: 10, medium: 4, low: 1 }

type Act = { key: string; label: string; name: string; role: string }
type Snap = {
  sig: string
  struct: string
  controls: Ctl[]
  url: string
}
type Ctl = {
  role: string
  name: string
  key: string
  pressed: string | null
  expanded: string | null
  x: number
  y: number
  w: number
  h: number
  tag: string
  href: string | null
  hit: string | null // null when the centre is not on the page, '' when the hit element is the control or inside it
  clipped: boolean
}
type State = { id: string; sig: string; struct: string; path: Act[]; depth: number; actions: Act[]; explored: Set<string>; shot: string }
type Edge = { from: string; action: string; to: string; label: string }
type Finding = { ruleId: string; severity: string; control: string; detail: string; stateId: string; screenshot: string; repro: string[]; states: Set<string> }

/** Runs inside the page: every visible, enabled interactive control, in DOM order, with geometry, the element at its centre and clipping. */
function collect() {
  const SEL = 'button,[role=button],a[href],[role=tab],[role=menuitem]'
  const vw = window.innerWidth
  const vh = window.innerHeight
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 60)
  const roleOf = (e: Element) => e.getAttribute('role') || (e.tagName === 'A' ? 'link' : 'button')
  const nameOf = (e: Element) => {
    const lab = e.getAttribute('aria-label')
    if (lab) return norm(lab)
    const by = e.getAttribute('aria-labelledby')
    if (by) {
      const t = by.split(/\s+/).map((i) => document.getElementById(i)?.textContent ?? '').join(' ')
      if (norm(t)) return norm(t)
    }
    const t = norm(e.textContent ?? '')
    return t || norm(e.getAttribute('title') ?? '') || '(unnamed)'
  }
  const describe = (e: Element) => {
    const lab = e.closest('[aria-label],[data-testid],[role]')
    const labelled = lab ? (lab.getAttribute('role') || lab.tagName.toLowerCase()) + ' "' + (lab.getAttribute('aria-label') || lab.getAttribute('data-testid') || '') + '"' : 'none'
    return e.tagName.toLowerCase() + '.' + (typeof (e as HTMLElement).className === 'string' ? (e as HTMLElement).className.trim().replace(/\s+/g, '.') : '') + ' [testid=' + (e.getAttribute('data-testid') ?? '') + '] nearest ' + labelled
  }
  const counts = new Map<string, number>()
  const out: Ctl[] = []
  for (const e of Array.from(document.querySelectorAll(SEL))) {
    const el = e as HTMLElement
    if ((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') continue
    if (el.closest('[aria-hidden=true],[inert]')) continue
    const r = el.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) continue
    const cs = getComputedStyle(el)
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) continue
    if (r.right <= 0 || r.bottom <= 0 || r.left >= vw || r.top >= vh) continue
    const role = roleOf(el)
    const name = nameOf(el)
    const base = role + '|' + name
    const n = (counts.get(base) ?? 0) + 1
    counts.set(base, n)
    const cx = r.left + r.width / 2
    const cy = r.top + r.height / 2
    let hit: string | null = null
    if (cx >= 0 && cy >= 0 && cx < vw && cy < vh) {
      const h = document.elementFromPoint(cx, cy)
      // Behind an open modal, the backdrop covering the page's controls is intended, not a defect.
      const modalHit = !!h && !!document.querySelector('[role=dialog],[aria-modal=true],[class*=backdrop]') && !!h.closest('[role=dialog],[aria-modal=true],[class*=backdrop],[class*=modal]') && !el.closest('[role=dialog],[aria-modal=true],[class*=modal]')
      hit = h && (el.contains(h) || modalHit) ? '' : h ? describe(h) : 'nothing'
    }
    let clipped = false
    if (el.scrollWidth > el.clientWidth + 1 && cs.textOverflow !== 'ellipsis' && cs.overflowX !== 'visible') clipped = true
    out.push({
      role, name, key: base + '#' + n,
      pressed: el.getAttribute('aria-pressed'), expanded: el.getAttribute('aria-expanded'),
      x: r.left, y: r.top, w: r.width, h: r.height, tag: el.tagName.toLowerCase(),
      href: el.tagName === 'A' ? (el as HTMLAnchorElement).href : null, hit, clipped,
    })
  }
  // Labels clipped the same way.
  for (const el of Array.from(document.querySelectorAll('label')) as HTMLElement[]) {
    const r = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    if (r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && el.scrollWidth > el.clientWidth + 1 && cs.textOverflow !== 'ellipsis' && cs.overflowX !== 'visible')
      out.push({ role: 'label', name: norm(el.textContent ?? '') || '(unnamed)', key: 'label|' + norm(el.textContent ?? ''), pressed: null, expanded: null, x: r.left, y: r.top, w: r.width, h: r.height, tag: 'label', href: null, hit: '', clipped: true })
  }
  const overlays = ['[role=dialog]', '[role=menu]', '[role=listbox]'].map((s) => (document.querySelector(s) ? 1 : 0)).join('')
  return { controls: out, overlays, path: location.pathname }
}

const fnv = (s: string) => {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) (h ^= s.charCodeAt(i)), (h = Math.imul(h, 0x01000193) >>> 0)
  return h.toString(16).padStart(8, '0')
}
// Free text and counters in names (row counts, timings) would make the signature unstable.
const stable = (s: string) => s.replace(/\d+/g, '#')

async function snapshot(page: Page): Promise<Snap> {
  const { controls, overlays, path } = await page.evaluate(collect)
  const real = controls.filter((c) => c.role !== 'label')
  const items = real.map((c) => ({ r: c.role, n: stable(c.name), p: c.pressed, e: c.expanded }))
  const plain = items.map((i) => i.r + '|' + i.n + '|' + (i.e ?? '')).sort()
  const full = items.map((i) => i.r + '|' + i.n + '|' + (i.p ?? '') + '|' + (i.e ?? '')).sort()
  return { sig: fnv(path + '\n' + overlays + '\n' + full.join('\n')), struct: fnv(path + '\n' + overlays + '\n' + plain.join('\n')), controls, url: path }
}

async function settle(page: Page, ms = 400) {
  await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {})
  await page.waitForTimeout(ms)
}

test('crawl the canvas and report UI defects', async ({ browser }, testInfo) => {
  rmSync(OUT, { recursive: true, force: true })
  mkdirSync(join(OUT, 'screens'), { recursive: true })
  const baseURL = testInfo.project.use.baseURL as string
  const origin = new URL(baseURL).origin
  const dataDir = process.env.AUDIT_DATA_DIR!
  const t0 = Date.now()

  let ctx: BrowserContext | undefined
  let page!: Page
  let leftApp = false

  // Reset: a fresh browser context (new localStorage, so no draft) and an emptied server-side canvas folder, then the start state.
  async function reset(): Promise<Snap> {
    await ctx?.close().catch(() => {})
    for (const d of ['canvases', 'canvas_history']) {
      try {
        for (const f of readdirSync(join(dataDir, d))) rmSync(join(dataDir, d, f), { recursive: true, force: true })
      } catch {
        /* folder not there yet */
      }
    }
    ctx = await browser.newContext({ baseURL, viewport: { width: 1500, height: 900 } })
    page = await ctx.newPage()
    leftApp = false
    page.on('dialog', (d) => d.dismiss().catch(() => {}))
    page.on('popup', (p) => {
      leftApp = true
      p.close().catch(() => {})
    })
    await start(page)
    await page.getByRole('tab', { name: 'Canvas' }).click()
    await page.getByRole('button', { name: '+ Query window' }).click()
    await expect(page.locator('.react-flow__node-query')).toHaveCount(1)
    await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important;caret-color:transparent!important}' })
    await page.mouse.move(2, 2)
    await settle(page, 600)
    return snapshot(page)
  }

  const states = new Map<string, State>()
  const bySig = new Map<string, string>()
  const edges: Edge[] = []
  const findings = new Map<string, Finding>()
  const queue: string[] = []
  let actionCount = 0
  let resetFailures = 0
  let replayMismatches = 0
  let startSig = ''
  let cur: string | null = null // the state the page is verifiably in right now (same signature as that state's), so no reset is needed to act on it again

  const actionsOf = (snap: Snap): Act[] => {
    const acts: Act[] = []
    for (const c of snap.controls) {
      if (c.role === 'label') continue
      if (DENY.test(c.name)) continue
      if (c.href && new URL(c.href, origin).origin !== origin) continue
      if (c.x + c.w / 2 < 0 || c.y + c.h / 2 < 0 || c.x + c.w / 2 >= 1500 || c.y + c.h / 2 >= 900) continue
      acts.push({ key: c.key, label: 'click ' + c.role + ' "' + c.name + '"' + (c.key.endsWith('#1') ? '' : ' (#' + c.key.split('#').pop() + ')'), name: c.name, role: c.role })
    }
    acts.push({ key: 'press|Escape', label: 'press Escape', name: 'Escape', role: 'key' })
    return acts
  }

  /** Performs one action as a real user would. Returns false when the control is not there to act on. */
  async function perform(a: Act): Promise<boolean> {
    if (a.key === 'press|Escape') {
      await page.keyboard.press('Escape')
      await settle(page)
      return true
    }
    const snap = await snapshot(page)
    const c = snap.controls.find((x) => x.key === a.key && x.role !== 'label')
    if (!c) return false
    const x = c.x + c.w / 2
    const y = c.y + c.h / 2
    await page.evaluate(([px, py]) => void ((window as any).__auditHit = document.elementFromPoint(px, py)?.tagName), [x, y]) // what a user's click lands on
    await page.mouse.click(x, y)
    await settle(page)
    if (leftApp || new URL(page.url()).origin !== origin) {
      leftApp = true
      return true
    }
    return true
  }

  function addFindings(state: State, snap: Snap) {
    const add = (ruleId: string, control: string, detail: string, dedupe: string) => {
      const k = ruleId + '|' + control + '|' + dedupe
      const f = findings.get(k)
      if (f) return void f.states.add(state.id)
      findings.set(k, { ruleId, severity: SEVERITY[ruleId], control, detail, stateId: state.id, screenshot: state.shot, repro: state.path.map((p) => p.label), states: new Set([state.id]) })
    }
    const cs = snap.controls.filter((c) => c.role !== 'label')
    const vw = 1500
    const vh = 900
    for (const c of snap.controls) {
      const label = c.role + ' "' + c.name + '"'
      if (c.clipped) add('clipped-text', label, 'text is wider than its box (' + Math.round(c.w) + 'px) without an ellipsis', '')
      if (c.role === 'label') continue
      if (c.hit) add('occluded-control', label, 'centre is covered by ' + c.hit, c.hit)
      if (c.x < 0 || c.y < 0 || c.x + c.w > vw || c.y + c.h > vh)
        add('offscreen-control', label, 'box ' + [c.x, c.y, c.w, c.h].map(Math.round).join(',') + ' is partly outside the ' + vw + 'x' + vh + ' viewport', '')
      if (c.w < 24 || c.h < 24) add('small-target', label, 'box is ' + Math.round(c.w) + 'x' + Math.round(c.h) + 'px (under 24x24)', '')
    }
    for (let i = 0; i < cs.length; i++)
      for (let j = i + 1; j < cs.length; j++) {
        const a = cs[i]
        const b = cs[j]
        const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
        const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
        if (ox <= 2 || oy <= 2) continue
        const contains = (p: Ctl, q: Ctl) => p.x <= q.x + 0.5 && p.y <= q.y + 0.5 && p.x + p.w >= q.x + q.w - 0.5 && p.y + p.h >= q.y + q.h - 0.5
        if (contains(a, b) || contains(b, a)) continue
        const names = [a.role + ' "' + a.name + '"', b.role + ' "' + b.name + '"'].sort()
        add('overlapping-controls', names.join(' x '), 'boxes intersect by ' + Math.round(ox) + 'x' + Math.round(oy) + 'px', '')
      }
  }

  /** Registers the state the page is in, if new (screenshot, findings, queue). Returns its id. */
  async function discover(snap: Snap, path: Act[], cap = Infinity): Promise<string | null> {
    const known = bySig.get(snap.sig)
    if (known) return known
    if (states.size >= cap) return null
    const id = 's' + states.size
    const shot = 'screens/' + id + '.png'
    await page.screenshot({ path: join(OUT, shot) }).catch(() => {})
    const state: State = { id, sig: snap.sig, struct: snap.struct, path, depth: path.length, actions: actionsOf(snap), explored: new Set(), shot }
    states.set(id, state)
    bySig.set(snap.sig, id)
    addFindings(state, snap)
    if (state.depth < MAX_DEPTH) queue.push(id)
    return id
  }

  /** Resets to the start and replays the path to a state. */
  async function goTo(state: State): Promise<boolean> {
    if (cur === state.id) return true
    cur = null
    for (let attempt = 0; attempt < 3; attempt++) {
      let ok = true
      try {
        const s = await reset()
        if (s.sig !== startSig) {
          resetFailures++
          ok = false
        } else {
          for (const a of state.path) if (!(await perform(a))) { ok = false; break }
          if (ok && (await snapshot(page)).sig !== state.sig) replayMismatches++
        }
      } catch (e) {
        resetFailures++
        ok = false
        console.log('reset error', String(e).slice(0, 200))
      }
      if (ok) return true
    }
    return false
  }

  /** Explores one action of a state (reset, replay, act), recording the edge. */
  async function explore(state: State, a: Act, budget: { n: number; max: number }): Promise<void> {
    if (state.explored.has(a.key) || budget.n >= budget.max) return
    state.explored.add(a.key)
    budget.n++
    actionCount++
    if (actionCount % 20 === 0) console.log('audit progress: ' + actionCount + ' actions, ' + states.size + ' states, ' + Math.round((Date.now() - t0) / 1000) + 's')
    if (!(await goTo(state))) return
    if (!(await perform(a))) return void (cur = null)
    if (leftApp) return void (cur = null)
    const snap = await snapshot(page)
    cur = snap.sig === state.sig ? state.id : null
    const to = await discover(snap, [...state.path, a], budget.max === MAX_ACTIONS ? Infinity : PHASE2_STATE_CAP)
    if (!to) return
    edges.push({ from: state.id, action: a.key, to, label: a.label })
  }

  // ---- crawl ----
  startSig = (await reset()).sig
  startSig = (await reset()).sig // the second reset must give the same start; goTo checks it every time from here on
  const first = await reset()
  if (first.sig !== startSig) throw new Error('the start state is not stable across resets')
  await discover(first, [])
  const crawl = { n: 0, max: MAX_ACTIONS }
  while (queue.length && states.size < MAX_STATES && crawl.n < crawl.max) {
    const s = states.get(queue.shift()!)!
    for (const a of s.actions) {
      if (states.size >= MAX_STATES || crawl.n >= crawl.max) break
      await explore(s, a, crawl)
    }
  }
  const crawled = crawl.n

  // ---- explicit return attempts ----
  const extra = { n: 0, max: EXTRA_ACTIONS }
  const outgoing = (id: string) => edges.filter((e) => e.from === id)
  const reaches = (b: string, a: string): boolean => {
    if (b === a) return true
    for (const e1 of outgoing(b)) {
      if (e1.to === a) return true
      for (const e2 of outgoing(e1.to)) if (e2.to === a) return true
    }
    return false
  }
  const candidates = () => edges.filter((e) => e.from !== e.to && e.action !== 'press|Escape' && !ONE_WAY.test(e.label) && !reaches(e.to, e.from))
  /** Tries the most likely ways back out of B first: the same control again (a toggle), Escape, then controls named like an undo. */
  async function tryReturn(e: Edge) {
    const B = states.get(e.to)!
    const rank = (a: Act) => (a.key === e.action ? 0 : a.key === 'press|Escape' ? 1 : RETURN_WORDS.test(a.name) ? 2 : 3)
    const order = [...B.actions].sort((x, y) => rank(x) - rank(y))
    let tried = 0
    for (const a of order) {
      if (reaches(e.to, e.from) || tried >= PER_STATE_RETURN_TRIES || extra.n >= extra.max) break
      if (!B.explored.has(a.key)) await explore(B, a, extra)
      tried++
    }
  }
  const triedB = new Set<string>()
  for (const e of [...candidates()]) {
    if (reaches(e.to, e.from)) continue
    await tryReturn(e)
    triedB.add(e.to)
  }
  let unverified = 0
  const seenIrr = new Set<string>()
  for (const e of candidates()) {
    const A = states.get(e.from)!
    const B = states.get(e.to)!
    if (B.explored.size < Math.min(B.actions.length, PER_STATE_RETURN_TRIES)) {
      unverified++
      continue
    }
    const k = e.label + '|' + A.struct + '|' + B.struct
    if (seenIrr.has(k)) continue
    seenIrr.add(k)
    const f: Finding = {
      ruleId: 'irreversible-transition', severity: 'high', control: e.label,
      detail: A.id + ' -> ' + B.id + ': no way back to ' + A.id + ' within 2 actions (tried ' + B.explored.size + ' of ' + B.actions.length + ' actions in ' + B.id + ')',
      stateId: B.id, screenshot: B.shot, repro: B.path.map((p) => p.label), states: new Set([B.id]),
    }
    findings.set('irreversible|' + k, f)
  }

  // ---- escape does nothing ----
  for (const e of [...edges]) {
    if (e.from === e.to || e.action === 'press|Escape') continue
    const A = states.get(e.from)!
    const B = states.get(e.to)!
    if (A.struct === B.struct) continue // only aria-pressed toggles differ
    const esc = B.actions.find((a) => a.key === 'press|Escape')!
    if (!B.explored.has(esc.key)) await explore(B, esc, { n: 0, max: 1 })
    const out = edges.find((x) => x.from === B.id && x.action === 'press|Escape')
    if (out && out.to === B.id) {
      const k = 'escape-does-nothing|' + e.label + '|' + A.struct
      if (!findings.has(k))
        findings.set(k, { ruleId: 'escape-does-nothing', severity: 'low', control: e.label, detail: 'Escape in ' + B.id + ' (reached from ' + A.id + ') changes nothing', stateId: B.id, screenshot: B.shot, repro: B.path.map((p) => p.label), states: new Set([B.id]) })
    }
  }

  // ---- report ----
  const list = [...findings.values()].map((f) => ({ ruleId: f.ruleId, severity: f.severity, control: f.control, detail: f.detail, stateId: f.stateId, screenshot: f.screenshot, repro: f.repro, stateCount: f.states.size }))
  const order = { high: 0, medium: 1, low: 2 } as Record<string, number>
  list.sort((a, b) => order[a.severity] - order[b.severity] || b.stateCount - a.stateCount)
  const byRule: Record<string, number> = {}
  let penalty = 0
  for (const f of list) {
    byRule[f.ruleId] = (byRule[f.ruleId] ?? 0) + 1
    penalty += WEIGHT[f.severity as keyof typeof WEIGHT]
  }
  const score = Math.max(0, 100 - penalty)
  const summary = { states: states.size, edges: edges.length, findingsByRule: byRule, score, actions: actionCount, crawledActions: crawled, resetFailures, replayMismatches, unverifiedReturns: unverified, seconds: Math.round((Date.now() - t0) / 1000) }
  writeFileSync(join(OUT, 'ui-findings.json'), JSON.stringify({ summary, findings: list }, null, 2))
  writeFileSync(join(OUT, 'graph.json'), JSON.stringify({ states: [...states.values()].map((s) => ({ id: s.id, sig: s.sig, depth: s.depth, path: s.path.map((p) => p.label), screenshot: s.shot, actions: s.actions.length, explored: s.explored.size })), edges }, null, 2))
  await ctx?.close().catch(() => {})
  console.log('audit: ' + summary.states + ' states, ' + summary.edges + ' edges, ' + list.length + ' findings (' + JSON.stringify(byRule) + '), score ' + score + ', ' + summary.seconds + 's')
})
