// A deterministic UI auditor: crawls each top-level view of the app in demo mode (BFS over clicks and Escape, replaying from a clean
// start) at two viewports and reports generic defects (irreversible transitions, toggles that cannot be undone, obscure exits,
// occluded or overlapping controls, clipped text). No LLM, no feature knowledge. See audit/README.md.
// It is a reporter, not a gate: the test passes whatever it finds. Output: web/audit-out/ui-findings.json, graph.json, screens/.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { start } from '../e2e/helpers'

const OUT = fileURLToPath(new URL('../audit-out', import.meta.url))
const num = (name: string, dflt: number) => Number(process.env[name] ?? dflt)
const DENY = /export|download|save as|copy|png|svg|open in|databricks|github/i
const ONE_WAY = /delete|remove|close|clear/i
const RETURN_WORDS = /delete|remove|close|clear|hide|undo|cancel|back|restore|dismiss|reset|minimi|collapse|toggle/i
const ROOTS = ['Canvas', 'Graph', 'Concepts', 'Ask', 'Agent access']
const VIEWPORTS = [
  { width: 1500, height: 900 },
  { width: 1280, height: 720 },
]
// Per root and viewport. The spec's budget is depth 3 / 40 states / 250 actions; the defaults below are lower so the whole run
// (5 roots x 2 viewports, about 2 s per action) stays near 25 minutes. Override with AUDIT_ACTIONS etc.
const MAX_DEPTH = num('AUDIT_DEPTH', 3)
const MAX_STATES = num('AUDIT_STATES', 40)
const MAX_ACTIONS = num('AUDIT_ACTIONS', 45)
const EXTRA_ACTIONS = num('AUDIT_EXTRA', 20) // return attempts after the crawl
const TOGGLE_CHECKS = num('AUDIT_TOGGLES', 8) // toggle-not-undoable replays per crawl
const PER_STATE_RETURN_TRIES = 10 // actions tried in B when looking for a way back
const SEVERITY: Record<string, 'high' | 'medium' | 'low' | 'info'> = {
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
const WEIGHT = { high: 10, medium: 4, low: 1, info: 0 }

// ---- expected.json: by-design findings, a maintainer's decision. They stay in the report, marked expected, and do not count toward the score. ----
type Expected = { rule: string; control: RegExp | string; root?: string; viewport?: string; reason: string; raw: unknown }
function loadExpected(): Expected[] {
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
const expectedList = loadExpected()
const nameOf = (label: string) => /"(.*)"/.exec(label)?.[1] ?? label
/** A string control equals the control's name (or its whole label); a regex is tested against both. irreversible-transition also matches the first click of the repro, because one one-way action shows up under every state it leads to. */
function expectedMatches(x: Expected, f: Finding): boolean {
  const names = [f.control, nameOf(f.control)]
  if (f.ruleId === 'irreversible-transition' && f.repro[1]) names.push(f.repro[1], nameOf(f.repro[1]))
  const hit = names.some((n) => (typeof x.control === 'string' ? n === x.control : x.control.test(n)))
  return hit && x.rule === f.ruleId && f.where.some((w) => (!x.root || w.root === x.root) && (!x.viewport || w.viewport === x.viewport))
}

type Act = { key: string; label: string; name: string; role: string }
type Snap = { sig: string; struct: string; controls: Ctl[]; overlaps: Overlap[]; open: string[]; url: string }
type Overlap = { a: string; b: string; ox: number; oy: number; top: string }
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
  vx: number // the part of the box that shows: clipped by every clipping ancestor and the viewport
  vy: number
  vw: number
  vh: number
  cx: number // centre of the visible part: where hit-testing and clicks go
  cy: number
  tag: string
  href: string | null
  hit: string | null // null when the centre is not on the page, '' when the hit element is the control or inside it
  clipped: boolean
  tid: string // data-testid or id
  dpath: string // tag:nth-child chain up to body
  cls: string // sorted class list
}
type State = { id: string; sig: string; struct: string; path: Act[]; depth: number; actions: Act[]; explored: Set<string>; shot: string; controls: Ctl[]; open: string[] }
type Edge = { from: string; action: string; to: string; label: string }
type Where = { root: string; viewport: string; stateId: string }
type Finding = {
  ruleId: string
  severity: string
  control: string
  detail: string
  occluder?: string
  screenshot: string
  repro: string[]
  where: Where[]
}

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
  const classes = (e: Element) => (typeof (e as HTMLElement).className === 'string' ? (e as HTMLElement).className.trim().split(/\s+/).filter(Boolean).sort().join('.') : '')
  // A stable selector: class list + testid + the nearest labelled ancestor.
  const describe = (e: Element) => {
    const lab = e.closest('[aria-label],[data-testid],[role]')
    const labelled = lab ? (lab.getAttribute('role') || lab.tagName.toLowerCase()) + ' "' + (lab.getAttribute('aria-label') || lab.getAttribute('data-testid') || '') + '"' : 'none'
    return e.tagName.toLowerCase() + '.' + classes(e) + ' [testid=' + (e.getAttribute('data-testid') ?? '') + '] nearest ' + labelled
  }
  const dpathOf = (e: Element) => {
    const parts: string[] = []
    for (let n: Element | null = e; n && n !== document.body; n = n.parentElement) parts.push(n.tagName.toLowerCase() + ':' + (Array.prototype.indexOf.call(n.parentElement?.children ?? [], n) + 1))
    return parts.reverse().join('>')
  }
  const isVis = (e: Element) => {
    const r = e.getBoundingClientRect()
    const s = getComputedStyle(e)
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && !e.closest('[aria-hidden=true],[inert]')
  }
  /** The part of the box that shows, or null: clipped by overflow/clip-path/contain:paint ancestors (absolute and fixed boxes skip the ones that are not their containing block) and the viewport; null too under opacity 0. */
  const visibleRect = (el: HTMLElement) => {
    const r = el.getBoundingClientRect()
    let l = Math.max(r.left, 0)
    let t = Math.max(r.top, 0)
    let rt = Math.min(r.right, vw)
    let b = Math.min(r.bottom, vh)
    for (let p = el.parentElement; p; p = p.parentElement) if (Number(getComputedStyle(p).opacity) === 0) return null
    let mode = getComputedStyle(el).position
    for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
      if (mode === 'fixed') break
      const ps = getComputedStyle(p)
      const skip = mode === 'absolute' && ps.position === 'static'
      const clips = ps.overflowX !== 'visible' || ps.overflowY !== 'visible' || ps.clipPath !== 'none' || /paint|content|strict/.test(ps.contain)
      if (!skip && clips && ps.display !== 'contents' && ps.display !== 'inline') {
        const pr = p.getBoundingClientRect()
        const pl = pr.left + p.clientLeft
        const pt = pr.top + p.clientTop
        l = Math.max(l, pl)
        t = Math.max(t, pt)
        rt = Math.min(rt, ps.overflowX === 'visible' && ps.clipPath === 'none' ? rt : pl + p.clientWidth)
        b = Math.min(b, ps.overflowY === 'visible' && ps.clipPath === 'none' ? b : pt + p.clientHeight)
      }
      if (!skip) mode = ps.position
    }
    return rt - l > 0.5 && b - t > 0.5 ? { x: l, y: t, w: rt - l, h: b - t } : null
  }
  // With modal dialogs open, only the topmost one is active; everything behind it is out of scope.
  const modals = (Array.from(document.querySelectorAll('[aria-modal=true],[role=dialog]')) as HTMLElement[]).filter((e) => isVis(e) && (e.getAttribute('aria-modal') === 'true' || !!e.closest('[class*=backdrop]')))
  if (!modals.length)
    for (const e of Array.from(document.querySelectorAll('[class*=backdrop]')) as HTMLElement[]) {
      const r = e.getBoundingClientRect()
      if (isVis(e) && r.width * r.height >= 0.8 * vw * vh) modals.push(e)
    }
  let topModal: HTMLElement | null = modals.length ? modals[modals.length - 1] : null
  for (const m of modals) {
    const r = m.getBoundingClientRect()
    const h = document.elementFromPoint(Math.min(Math.max(r.left + r.width / 2, 0), vw - 1), Math.min(Math.max(r.top + r.height / 2, 0), vh - 1))
    if (h && m.contains(h)) topModal = m
  }
  const behind: string[] = []
  const counts = new Map<string, number>()
  const out: Ctl[] = []
  const els: HTMLElement[] = []
  for (const e of Array.from(document.querySelectorAll(SEL))) {
    const el = e as HTMLElement
    if ((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') continue
    if (el.closest('[aria-hidden=true],[inert]')) continue
    const r = el.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) continue
    const cs = getComputedStyle(el)
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) continue
    if (topModal && !topModal.contains(el)) {
      // Out of scope, but it still tells states apart: the same dialog over a different page is a different state.
      behind.push(roleOf(el) + '|' + nameOf(el) + '|' + (el.getAttribute('aria-pressed') ?? '') + '|' + (el.getAttribute('aria-expanded') ?? ''))
      continue
    }
    const vr = visibleRect(el)
    if (!vr) continue
    const role = roleOf(el)
    const name = nameOf(el)
    const base = role + '|' + name
    const n = (counts.get(base) ?? 0) + 1
    counts.set(base, n)
    const cx = vr.x + vr.w / 2
    const cy = vr.y + vr.h / 2
    const h = document.elementFromPoint(cx, cy)
    const hit: string = h && el.contains(h) ? '' : h ? describe(h) : 'nothing'
    let clipped = false
    if (el.scrollWidth > el.clientWidth + 1 && cs.textOverflow !== 'ellipsis' && cs.overflowX !== 'visible') clipped = true
    els.push(el)
    out.push({
      role, name, key: base + '#' + n,
      pressed: el.getAttribute('aria-pressed'), expanded: el.getAttribute('aria-expanded'),
      x: r.left, y: r.top, w: r.width, h: r.height, vx: vr.x, vy: vr.y, vw: vr.w, vh: vr.h, cx, cy, tag: el.tagName.toLowerCase(),
      href: el.tagName === 'A' ? (el as HTMLAnchorElement).href : null, hit, clipped,
      tid: el.getAttribute('data-testid') || el.id || '', dpath: dpathOf(el), cls: classes(el),
    })
  }
  // Overlapping controls, with the element that is on top at the middle of the overlap (the occluder).
  const overlaps: Overlap[] = []
  for (let i = 0; i < out.length; i++)
    for (let j = i + 1; j < out.length; j++) {
      const a = out[i]
      const b = out[j]
      const ox = Math.min(a.vx + a.vw, b.vx + b.vw) - Math.max(a.vx, b.vx)
      const oy = Math.min(a.vy + a.vh, b.vy + b.vh) - Math.max(a.vy, b.vy)
      if (ox <= 2 || oy <= 2) continue
      const contains = (p: Ctl, q: Ctl) => p.vx <= q.vx + 0.5 && p.vy <= q.vy + 0.5 && p.vx + p.vw >= q.vx + q.vw - 0.5 && p.vy + p.vh >= q.vy + q.vh - 0.5
      if (contains(a, b) || contains(b, a)) continue
      const mx = Math.max(a.vx, b.vx) + ox / 2
      const my = Math.max(a.vy, b.vy) + oy / 2
      const t = document.elementFromPoint(mx, my)
      overlaps.push({ a: a.role + ' "' + a.name + '"', b: b.role + ' "' + b.name + '"', ox, oy, top: t ? describe(t) : 'nothing' })
    }
  // Labels clipped the same way.
  for (const el of Array.from(document.querySelectorAll('label')) as HTMLElement[]) {
    const r = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    if (r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && el.scrollWidth > el.clientWidth + 1 && cs.textOverflow !== 'ellipsis' && cs.overflowX !== 'visible')
      out.push({ role: 'label', name: norm(el.textContent ?? '') || '(unnamed)', key: 'label|' + norm(el.textContent ?? ''), pressed: null, expanded: null, x: r.left, y: r.top, w: r.width, h: r.height, vx: r.left, vy: r.top, vw: r.width, vh: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2, tag: 'label', href: null, hit: '', clipped: true, tid: '', dpath: '', cls: '' })
  }
  const overlays = ['[role=dialog]', '[role=menu]', '[role=listbox]'].map((s) => (document.querySelector(s) ? 1 : 0)).join('')
  // What Escape is expected to close: visible dialogs, menus, listboxes, open popovers, and controls that expanded a popup (aria-haspopup).
  const open: string[] = []
  for (const s of ['dialog', 'menu', 'listbox'])
    for (const e of Array.from(document.querySelectorAll('[role=' + s + ']'))) if (isVis(e)) open.push(s + ':' + (e.getAttribute('aria-label') || e.getAttribute('data-testid') || ''))
  for (const e of Array.from(document.querySelectorAll('[popover]')))
    try {
      if (e.matches(':popover-open')) open.push('popover:' + (e.getAttribute('aria-label') || e.id))
    } catch {
      /* :popover-open unsupported */
    }
  const popupControls = new Set(Array.from(document.querySelectorAll('[aria-haspopup]:not([aria-haspopup=false])')))
  els.forEach((el, i) => {
    if (out[i].expanded === 'true' && popupControls.has(el)) open.push('popup:' + out[i].key)
  })
  return { controls: out, overlaps, overlays, open, path: location.pathname, behind: behind.sort().join('\n') }
}

const fnv = (s: string) => {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) (h ^= s.charCodeAt(i)), (h = Math.imul(h, 0x01000193) >>> 0)
  return h.toString(16).padStart(8, '0')
}
// Free text and counters in names (row counts, timings) would make the signature unstable.
const stable = (s: string) => s.replace(/\d+/g, '#')

async function snapshot(page: Page): Promise<Snap> {
  const { controls, overlaps, overlays, open, path, behind } = await page.evaluate(collect)
  const real = controls.filter((c) => c.role !== 'label')
  const items = real.map((c) => ({ r: c.role, n: stable(c.name), p: c.pressed, e: c.expanded }))
  const plain = items.map((i) => i.r + '|' + i.n + '|' + (i.e ?? '')).sort()
  const full = items.map((i) => i.r + '|' + i.n + '|' + (i.p ?? '') + '|' + (i.e ?? '')).sort()
  const bg = stable(behind)
  return { sig: fnv(path + '\n' + overlays + '\n' + full.join('\n') + '\n' + bg), struct: fnv(path + '\n' + overlays + '\n' + plain.join('\n') + '\n' + bg), controls, overlaps, open, url: path }
}

async function settle(page: Page, ms = 300) {
  await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {})
  await page.waitForTimeout(ms)
}

/** The same control in another state: by testid/id, else DOM position, else class list and screen position (names change, e.g. Maximize -> Restore). */
function match(c: Ctl, list: Ctl[]): Ctl | undefined {
  const L = list.filter((x) => x.role !== 'label')
  if (c.tid) {
    const m = L.find((x) => x.tid === c.tid)
    if (m) return m
  }
  return L.find((x) => x.dpath === c.dpath && x.tag === c.tag) ?? L.find((x) => x.cls === c.cls && Math.abs(x.x - c.x) < 4 && Math.abs(x.y - c.y) < 4)
}

test('crawl every top-level view and report UI defects', async ({ browser }, testInfo) => {
  rmSync(OUT, { recursive: true, force: true })
  mkdirSync(join(OUT, 'screens'), { recursive: true })
  const baseURL = testInfo.project.use.baseURL as string
  const origin = new URL(baseURL).origin
  const dataDir = process.env.AUDIT_DATA_DIR!
  const t0 = Date.now()

  const findings = new Map<string, Finding>()
  const crawls: Record<string, unknown>[] = []
  const graphs: Record<string, unknown>[] = []

  async function runCrawl(root: string, vp: { width: number; height: number }) {
    const vpName = vp.width + 'x' + vp.height
    const prefix = root.toLowerCase().replace(/[^a-z]+/g, '-') + '-' + vp.width
    const tStart = Date.now()
    let ctx: BrowserContext | undefined
    let page!: Page
    let leftApp = false

    // Reset: a fresh browser context (new localStorage, so no draft) and an emptied server-side canvas folder, then the root's start state.
    async function reset(): Promise<Snap> {
      await ctx?.close().catch(() => {})
      for (const d of ['canvases', 'canvas_history']) {
        try {
          for (const f of readdirSync(join(dataDir, d))) rmSync(join(dataDir, d, f), { recursive: true, force: true })
        } catch {
          /* folder not there yet */
        }
      }
      ctx = await browser.newContext({ baseURL, viewport: vp })
      page = await ctx.newPage()
      leftApp = false
      page.on('dialog', (d) => d.dismiss().catch(() => {}))
      page.on('popup', (p) => {
        leftApp = true
        p.close().catch(() => {})
      })
      await start(page)
      if (root === 'Agent access') await page.getByRole('button', { name: 'Agent access' }).click()
      else {
        await page.getByRole('tab', { name: root }).click()
        if (root === 'Canvas') {
          await page.getByRole('button', { name: '+ Query window' }).click()
          await expect(page.locator('.react-flow__node-query')).toHaveCount(1)
        }
      }
      await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important;caret-color:transparent!important}' })
      await page.mouse.move(2, 2)
      await settle(page, 600)
      return snapshot(page)
    }

    const states = new Map<string, State>()
    const bySig = new Map<string, string>()
    const edges: Edge[] = []
    const queue: string[] = []
    let actionCount = 0
    let resetFailures = 0
    let replayMismatches = 0
    let startSig = ''
    let cur: string | null = null // the state the page is verifiably in right now, so no reset is needed to act on it again
    const unverified: { edge: string; from: string; to: string; reason: string }[] = []
    const extra = { n: 0, max: EXTRA_ACTIONS }

    const actionsOf = (snap: Snap): Act[] => {
      const acts: Act[] = []
      for (const c of snap.controls) {
        if (c.role === 'label') continue
        if (DENY.test(c.name)) continue
        if (c.role === 'tab' && ROOTS.includes(c.name)) continue // the top-level views are the crawl roots
        if (c.href && new URL(c.href, origin).origin !== origin) continue
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
      await page.mouse.click(c.cx, c.cy)
      await settle(page)
      if (leftApp || new URL(page.url()).origin !== origin) leftApp = true
      return true
    }

    const reproOf = (path: Act[]) => ['root "' + root + '" at ' + vpName, ...path.map((p) => p.label)]

    /** Records a finding once across all roots and viewports, remembering where else it showed up. */
    function report(ruleId: string, control: string, detail: string, dedupe: string, st: { id: string; shot: string; path: Act[] }, occluder?: string) {
      const k = ruleId + '|' + control + '|' + dedupe
      const where = { root, viewport: vpName, stateId: prefix + '-' + st.id }
      const f = findings.get(k)
      if (f) {
        if (!f.where.some((w) => w.root === root && w.viewport === vpName)) f.where.push(where)
        return
      }
      findings.set(k, { ruleId, severity: SEVERITY[ruleId], control, detail, occluder, screenshot: st.shot, repro: reproOf(st.path), where: [where] })
    }

    function addFindings(state: State, snap: Snap) {
      const add = (ruleId: string, control: string, detail: string, dedupe: string, occluder?: string) => report(ruleId, control, detail, dedupe, state, occluder)
      for (const c of snap.controls) {
        const label = c.role + ' "' + c.name + '"'
        if (c.clipped) add('clipped-text', label, 'text is wider than its box (' + Math.round(c.w) + 'px) without an ellipsis', '')
        if (c.role === 'label') continue
        if (c.hit) add('occluded-control', label, 'centre is covered by ' + c.hit, c.hit, c.hit)
        if (c.x < 0 || c.y < 0 || c.x + c.w > vp.width || c.y + c.h > vp.height)
          add('offscreen-control', label, 'box ' + [c.x, c.y, c.w, c.h].map(Math.round).join(',') + ' is partly outside the ' + vpName + ' viewport', '')
        if (c.w < 24 || c.h < 24) add('small-target', label, 'box is ' + Math.round(c.w) + 'x' + Math.round(c.h) + 'px (under 24x24)', '')
      }
      for (const o of snap.overlaps) add('overlapping-controls', [o.a, o.b].sort().join(' x '), 'boxes intersect by ' + Math.round(o.ox) + 'x' + Math.round(o.oy) + 'px; on top at the overlap: ' + o.top, '', o.top)
    }

    /** Registers the state the page is in, if new (screenshot, findings, queue). Returns its id. */
    async function discover(snap: Snap, path: Act[], cap = Infinity): Promise<string | null> {
      const known = bySig.get(snap.sig)
      if (known) return known
      if (states.size >= cap) return null
      const id = 's' + states.size
      const shot = 'screens/' + prefix + '-' + id + '.png'
      await page.screenshot({ path: join(OUT, shot) }).catch(() => {})
      const state: State = { id, sig: snap.sig, struct: snap.struct, path, depth: path.length, actions: actionsOf(snap), explored: new Set(), shot, controls: snap.controls, open: snap.open }
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
            for (const a of state.path)
              if (!(await perform(a))) {
                ok = false
                break
              }
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
    async function explore(state: State, a: Act, budget: { n: number; max: number }, stateCap = Infinity): Promise<void> {
      if (state.explored.has(a.key) || budget.n >= budget.max) return
      state.explored.add(a.key)
      budget.n++
      actionCount++
      if (actionCount % 20 === 0) console.log('audit progress [' + root + ' ' + vpName + ']: ' + actionCount + ' actions, ' + states.size + ' states, ' + Math.round((Date.now() - t0) / 1000) + 's')
      if (!(await goTo(state))) return void state.explored.delete(a.key) // not tried: it must not count as tried, or an edge would look checked
      if (!(await perform(a))) return void (cur = null)
      if (leftApp) return void (cur = null)
      const snap = await snapshot(page)
      cur = snap.sig === state.sig ? state.id : null
      const to = await discover(snap, [...state.path, a], stateCap)
      if (!to) return
      edges.push({ from: state.id, action: a.key, to, label: a.label })
    }

    // ---- crawl ----
    startSig = (await reset()).sig
    const first = await reset() // the second reset must give the same start; goTo checks it every time from here on
    if (first.sig !== startSig) throw new Error('the start state of ' + root + ' is not stable across resets')
    await discover(first, [])
    const crawl = { n: 0, max: MAX_ACTIONS }
    while (queue.length && states.size < MAX_STATES && crawl.n < crawl.max) {
      const s = states.get(queue.shift()!)!
      for (const a of s.actions) {
        if (states.size >= MAX_STATES || crawl.n >= crawl.max) break
        await explore(s, a, crawl, MAX_STATES)
      }
    }
    const crawled = crawl.n

    // ---- explicit return attempts ----
    const outgoing = (id: string) => edges.filter((e) => e.from === id)
    const reaches = (b: string, a: string): boolean => {
      if (b === a) return true
      for (const e1 of outgoing(b)) {
        if (e1.to === a) return true
        for (const e2 of outgoing(e1.to)) if (e2.to === a) return true
      }
      return false
    }
    const candidates = () => edges.filter((e) => e.from !== e.to && e.action !== 'press|Escape' && !ONE_WAY.test(e.label))
    /** Tries the most likely ways back out of B first: the same control again (a toggle), Escape, then controls named like an undo. */
    async function tryReturn(e: Edge) {
      const B = states.get(e.to)!
      const rank = (a: Act) => (a.key === e.action ? 0 : a.key === 'press|Escape' ? 1 : RETURN_WORDS.test(a.name) ? 2 : 3)
      const order = [...B.actions].sort((x, y) => rank(x) - rank(y))
      let tried = B.explored.size
      for (const a of order) {
        if (reaches(e.to, e.from) || tried >= PER_STATE_RETURN_TRIES || extra.n >= extra.max) break
        if (!B.explored.has(a.key)) {
          await explore(B, a, extra, MAX_STATES + 20)
          tried++
        }
      }
    }
    // States with the fewest actions first: they can be settled cheaply, so the budget goes furthest.
    for (const e of [...candidates()].filter((x) => !reaches(x.to, x.from)).sort((x, y) => states.get(x.to)!.actions.length - states.get(y.to)!.actions.length)) {
      if (reaches(e.to, e.from)) continue
      await tryReturn(e)
    }

    const checked = (B: State) => B.explored.size >= Math.min(B.actions.length, PER_STATE_RETURN_TRIES)
    const seenEdge = new Set<string>()
    const visibleInA = (A: State, c: Ctl) => A.controls.some((x) => x.role !== 'label' && Math.hypot(x.cx - c.cx, x.cy - c.cy) <= 6)
    for (const e of candidates()) {
      const A = states.get(e.from)!
      const B = states.get(e.to)!
      const k = e.label + '|' + A.struct + '|' + B.struct
      if (seenEdge.has(k)) continue
      const back = reaches(e.to, e.from)
      if (!back && !checked(B)) {
        unverified.push({ edge: e.label, from: e.from, to: e.to, reason: extra.n >= extra.max ? 'return-attempt budget exhausted (' + B.explored.size + ' of ' + B.actions.length + ' actions in ' + B.id + ' tried)' : B.explored.size + ' of ' + B.actions.length + ' actions in ' + B.id + ' tried' })
        continue
      }
      seenEdge.add(k)
      if (!back) {
        report('irreversible-transition', e.label, A.id + ' -> ' + B.id + ': no way back to ' + A.id + ' within 2 actions (tried ' + B.explored.size + ' of ' + B.actions.length + ' actions in ' + B.id + ')', A.struct + '|' + B.struct, B)
        continue
      }
      // A way back exists. Is any of them one a user would find: no Escape, every control visible in A at the same screen position?
      const stateOf = (id: string) => states.get(id)!
      const ctlOf = (from: string, ed: Edge) => stateOf(from).controls.find((c) => c.key === ed.action && c.role !== 'label')
      const paths: Edge[][] = []
      for (const e1 of outgoing(B.id)) {
        if (e1.to === A.id) paths.push([e1])
        else for (const e2 of outgoing(e1.to)) if (e2.to === A.id) paths.push([e1, e2])
      }
      // A dialog that A lacked is left through its own buttons (Close, Cancel): those are the expected exit even though A never showed them.
      const dialogOpened = B.open.some((t) => /^dialog:/.test(t) && !A.open.includes(t))
      const obvious = (p: Edge[]) => p.every((ed, i) => {
        if (ed.action === 'press|Escape') return false
        if (dialogOpened && i === 0) return true
        const c = ctlOf(ed.from, ed)
        return !!c && visibleInA(A, c)
      })
      if (paths.length && !paths.some(obvious)) {
        const how = paths[0].map((ed) => ed.label).join(' then ')
        report('only-obscure-exit', e.label, A.id + ' -> ' + B.id + ': the only way back found is "' + how + '", which is Escape or a control that was not visible in ' + A.id + ' at the same position', A.struct + '|' + B.struct, B)
      }
    }

    // ---- toggle-not-undoable ----
    const seenTog = new Set<string>()
    let toggles = 0
    for (const e of [...edges]) {
      if (toggles >= TOGGLE_CHECKS) break
      if (e.from === e.to || e.action === 'press|Escape' || ONE_WAY.test(e.label)) continue
      const A = states.get(e.from)!
      const B = states.get(e.to)!
      if (A.sig === B.sig) continue
      const cA = A.controls.find((c) => c.key === e.action && c.role !== 'label')
      const cB = cA && match(cA, B.controls)
      if (!cA || !cB) continue
      // Only controls whose label or pressed/expanded state changed are toggles; an "add" button that looks the same afterwards is not.
      if (stable(cB.name) === stable(cA.name) && cB.pressed === cA.pressed && cB.expanded === cA.expanded) continue
      const k = e.label + '|' + A.struct + '|' + B.struct
      if (seenTog.has(k)) continue
      seenTog.add(k)
      toggles++
      if (!(await goTo(B))) continue
      const live = await snapshot(page)
      const cL = match(cA, live.controls)
      if (!cL) continue
      const x = cL.cx
      const y = cL.cy
      await page.mouse.click(x, y)
      await settle(page)
      const after = await snapshot(page)
      cur = after.sig === B.sig ? B.id : null
      if (after.sig === A.sig) continue
      const landed = bySig.get(after.sig) ?? (await discover(after, [...B.path, { key: cL.key, label: 'click ' + cL.role + ' "' + cL.name + '" (again)', name: cL.name, role: cL.role }], MAX_STATES + 20))
      const hit = cL.hit ? 'the click at (' + Math.round(x) + ',' + Math.round(y) + ') hit ' + cL.hit : 'the click at (' + Math.round(x) + ',' + Math.round(y) + ') hit the control itself'
      report('toggle-not-undoable', e.label, A.id + ' -> ' + B.id + ' (control is now ' + cL.role + ' "' + cL.name + '"): clicking it again leads ' + (after.sig === B.sig ? 'nowhere (state unchanged)' : 'to ' + (landed ?? 'a new state') + ', not back to ' + A.id) + '; ' + hit, A.struct + '|' + B.struct, B)
    }

    // ---- escape does nothing ----
    for (const e of [...edges]) {
      if (e.from === e.to || e.action === 'press|Escape') continue
      const A = states.get(e.from)!
      const B = states.get(e.to)!
      if (!B.open.some((t) => !A.open.includes(t))) continue // B opened nothing that Escape would be expected to close
      const esc = B.actions.find((a) => a.key === 'press|Escape')!
      if (!B.explored.has(esc.key)) await explore(B, esc, { n: 0, max: 1 }, MAX_STATES + 20)
      const out = edges.find((x) => x.from === B.id && x.action === 'press|Escape')
      if (out && out.to === B.id) report('escape-does-nothing', e.label, 'Escape in ' + B.id + ' (reached from ' + A.id + ') changes nothing, though ' + B.id + ' has ' + B.open.filter((t) => !A.open.includes(t)).join(', ') + ' that ' + A.id + ' lacked', A.struct, B)
    }

    const seconds = Math.round((Date.now() - tStart) / 1000)
    crawls.push({ root, viewport: vpName, states: states.size, edges: edges.length, actions: actionCount, crawledActions: crawled, resetFailures, replayMismatches, unverifiedReturns: unverified.length, unverified, seconds })
    graphs.push({
      root, viewport: vpName,
      states: [...states.values()].map((s) => ({ id: prefix + '-' + s.id, sig: s.sig, depth: s.depth, path: s.path.map((p) => p.label), screenshot: s.shot, actions: s.actions.length, explored: s.explored.size })),
      edges: edges.map((e) => ({ ...e, from: prefix + '-' + e.from, to: prefix + '-' + e.to })),
    })
    await ctx?.close().catch(() => {})
    console.log('audit crawl ' + root + ' ' + vpName + ': ' + states.size + ' states, ' + edges.length + ' edges, ' + actionCount + ' actions, ' + unverified.length + ' unverified, ' + seconds + 's')
  }

  for (const vp of VIEWPORTS) for (const root of ROOTS) await runCrawl(root, vp)

  // ---- report ----
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
  let total = 0
  for (const f of counted) if (!f.occluder) total += WEIGHT[f.severity as keyof typeof WEIGHT]
  for (const g of groups.values()) total += WEIGHT[g.severity as keyof typeof WEIGHT]
  const score = Math.round(100 * Math.exp(-total / 50))
  const summary = {
    crawls: crawls.length, score, weightedCauses: total, findingsByRule: byRule, expectedByRule, staleExpected, rootCauses, perCrawl: crawls,
    states: crawls.reduce((n, c) => n + (c.states as number), 0), actions: crawls.reduce((n, c) => n + (c.actions as number), 0),
    unverifiedReturns: crawls.reduce((n, c) => n + (c.unverifiedReturns as number), 0), seconds: Math.round((Date.now() - t0) / 1000),
  }
  writeFileSync(join(OUT, 'ui-findings.json'), JSON.stringify({ summary, findings: list }, null, 2))
  writeFileSync(join(OUT, 'graph.json'), JSON.stringify(graphs, null, 2))
  console.log('audit: ' + summary.crawls + ' crawls, ' + list.length + ' findings (' + JSON.stringify(byRule) + ', expected ' + JSON.stringify(expectedByRule) + ', stale ' + staleExpected.length + '), score ' + score + ', ' + summary.seconds + 's')
})
