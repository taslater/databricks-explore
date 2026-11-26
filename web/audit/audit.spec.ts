// A deterministic UI auditor: crawls each top-level view of the app in demo mode (BFS over clicks and Escape, replaying from a clean
// start) at two viewports and reports generic defects (irreversible transitions, toggles that cannot be undone, obscure exits,
// occluded or overlapping controls, clipped text). No LLM, no feature knowledge. See audit/README.md.
// It is a reporter, not a gate: the test passes whatever it finds. Output: web/audit-out/ui-findings.json, graph.json, screens/.
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test as base, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { start } from '../e2e/helpers'
import { SEVERITY, type Finding, type Part } from './report'

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
// Folders under the data dir that hold what a user creates; the caches and logs are left alone.
const USER_DATA = ['canvases', 'canvas_history', 'diagrams', 'diagram_history', 'relationships']

type Act = { key: string; label: string; name: string; role: string }
type Snap = { sig: string; struct: string; controls: Ctl[]; off: Off[]; meta: string; overlaps: Overlap[]; open: string[]; url: string }
/** A control that is shown but disabled: kept out of the actions, but part of the loose comparison (enabled/disabled flips are not a change of state). */
type Off = { role: string; name: string; pressed: string | null; expanded: string | null; sel: boolean }
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
  sel: boolean // part of the selection: aria-selected, a selected class, a resize handle, or inside such an element
  tid: string // data-testid or id
  dpath: string // tag:nth-child chain up to body
  cls: string // sorted class list
}
type State = { id: string; sig: string; struct: string; path: Act[]; depth: number; actions: Act[]; explored: Set<string>; shot: string; controls: Ctl[]; off: Off[]; meta: string; open: string[] }
type Edge = { from: string; action: string; to: string; label: string }
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
  /** Selection-related: aria-selected, a selected class or a resize handle on the element or an ancestor. Comparing states loosely ignores these. */
  const selFlag = (e: Element) => {
    if (e.getAttribute('aria-selected') === 'true') return true
    for (let n: Element | null = e; n && n !== document.body; n = n.parentElement)
      if (typeof (n as HTMLElement).className === 'string' && (n as HTMLElement).className.split(/\s+/).some((t) => /^selected$|^is-selected$|[-_]selected$|resize/i.test(t))) return true
    return false
  }
  const off: Off[] = []
  const behind: string[] = []
  const counts = new Map<string, number>()
  const out: Ctl[] = []
  const els: HTMLElement[] = []
  for (const e of Array.from(document.querySelectorAll(SEL))) {
    const el = e as HTMLElement
    if (el.closest('[aria-hidden=true],[inert]')) continue
    const r = el.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) continue
    const cs = getComputedStyle(el)
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) continue
    if ((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') {
      if ((!topModal || topModal.contains(el)) && visibleRect(el)) off.push({ role: roleOf(el), name: nameOf(el), pressed: el.getAttribute('aria-pressed'), expanded: el.getAttribute('aria-expanded'), sel: selFlag(el) })
      continue
    }
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
      href: el.tagName === 'A' ? (el as HTMLAnchorElement).href : null, hit, clipped, sel: selFlag(el),
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
      out.push({ role: 'label', name: norm(el.textContent ?? '') || '(unnamed)', key: 'label|' + norm(el.textContent ?? ''), pressed: null, expanded: null, x: r.left, y: r.top, w: r.width, h: r.height, vx: r.left, vy: r.top, vw: r.width, vh: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2, tag: 'label', href: null, hit: '', clipped: true, sel: false, tid: '', dpath: '', cls: '' })
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
  return { controls: out, off, overlaps, overlays, open, path: location.pathname, behind: behind.sort().join('\n') }
}

/** One line per control of a state, for graph.json: enabled ones with their pressed/expanded state, disabled ones, and selection-related ones. */
const describeControls = (s: Cmp) => [
  ...s.controls.filter((c) => c.role !== 'label').map((c) => c.role + ' "' + c.name + '"' + (c.pressed != null ? ' pressed=' + c.pressed : '') + (c.expanded != null ? ' expanded=' + c.expanded : '') + (c.sel ? ' [selection]' : '')),
  ...s.off.map((o) => o.role + ' "' + o.name + '"' + (o.pressed != null ? ' pressed=' + o.pressed : '') + (o.expanded != null ? ' expanded=' + o.expanded : '') + ' [disabled]' + (o.sel ? ' [selection]' : '')),
]

const fnv = (s: string) => {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) (h ^= s.charCodeAt(i)), (h = Math.imul(h, 0x01000193) >>> 0)
  return h.toString(16).padStart(8, '0')
}
// Free text and counters in names (row counts, timings) would make the signature unstable.
const stable = (s: string) => s.replace(/\d+/g, '#')

/** Wall time per activity of the crawl in progress (a worker runs one crawl at a time), reported in summary.timing. */
const newTiming = () => ({ resetMs: 0, resetWipeMs: 0, replayMs: 0, actMs: 0, settleMs: 0, snapshotMs: 0, screenshotMs: 0, resets: 0, snapshots: 0, settles: 0, screenshots: 0 })
let tm = newTiming()

async function snapshot(page: Page): Promise<Snap> {
  const t = Date.now()
  try {
    return await snapshotInner(page)
  } finally {
    tm.snapshotMs += Date.now() - t
    tm.snapshots++
  }
}

async function snapshotInner(page: Page): Promise<Snap> {
  const { controls, off, overlaps, overlays, open, path, behind } = await page.evaluate(collect)
  const real = controls.filter((c) => c.role !== 'label')
  const items = real.map((c) => ({ r: c.role, n: stable(c.name), p: c.pressed, e: c.expanded }))
  const plain = items.map((i) => i.r + '|' + i.n + '|' + (i.e ?? '')).sort()
  const full = items.map((i) => i.r + '|' + i.n + '|' + (i.p ?? '') + '|' + (i.e ?? '')).sort()
  const bg = stable(behind)
  return { sig: fnv(path + '\n' + overlays + '\n' + full.join('\n') + '\n' + bg), struct: fnv(path + '\n' + overlays + '\n' + plain.join('\n') + '\n' + bg), controls, off, meta: path + '\n' + overlays + '\n' + bg, overlaps, open, url: path }
}

async function settle(page: Page, ms = 300) {
  const t = Date.now()
  await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {})
  await page.waitForTimeout(ms)
  tm.settleMs += Date.now() - t
  tm.settles++
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

/** What a state is made of, for comparing: the page and overlay context plus every control (enabled or disabled). */
type Cmp = { controls: Ctl[]; off: Off[]; meta: string }
/**
 * What differs between two states, as short phrases (empty: same). Loose comparison ignores selection: aria-selected, selected classes, resize
 * handles (a control that is part of the selection may appear or disappear freely) and whether a control is enabled or disabled. Strict
 * comparison reports those too, so a finding can say what a loose match overlooked.
 */
function diffStates(a: Cmp, b: Cmp, loose: boolean): string[] {
  if (a.meta !== b.meta) return ['the page, dialogs or the background behind a dialog differ']
  type Tally = { n: number; sel: number }
  const tally = (s: Cmp) => {
    const m = new Map<string, Tally>()
    const add = (r: string, name: string, p: string | null, e: string | null, sel: boolean, off: boolean) => {
      const k = r + ' "' + stable(name) + '"' + (p != null ? ' pressed=' + p : '') + (e != null ? ' expanded=' + e : '') + (loose ? '' : (sel ? ' [selection]' : '') + (off ? ' [disabled]' : ''))
      const t = m.get(k) ?? { n: 0, sel: 0 }
      t.n++
      if (sel) t.sel++
      m.set(k, t)
    }
    for (const c of s.controls) if (c.role !== 'label') add(c.role, c.name, c.pressed, c.expanded, c.sel, false)
    for (const o of s.off) add(o.role, o.name, o.pressed, o.expanded, o.sel, true)
    return m
  }
  const ta = tally(a)
  const tb = tally(b)
  const out: string[] = []
  for (const k of new Set([...ta.keys(), ...tb.keys()])) {
    const x = ta.get(k) ?? { n: 0, sel: 0 }
    const y = tb.get(k) ?? { n: 0, sel: 0 }
    const d = x.n - y.n
    if (d === 0) continue
    if (loose && (d > 0 ? x.sel >= d : y.sel >= -d)) continue // the surplus is part of the selection
    out.push((d > 0 ? 'only before: ' : 'only after: ') + k + (Math.abs(d) > 1 ? ' x' + Math.abs(d) : ''))
  }
  return out
}
const brief = (d: string[]) => (d.length > 6 ? d.slice(0, 6).join('; ') + '; +' + (d.length - 6) + ' more' : d.join('; '))

/** The opposite of a control's name: Hide X / Show X, Open / Close, Expand / Collapse, Maximize / Restore, Zoom In / Zoom Out. */
const OPPOSITES: [RegExp, RegExp][] = [
  [/^hide\b/i, /^show\b/i], [/^open\b/i, /^close\b/i], [/^expand\b/i, /^collapse\b/i], [/^maximi[sz]e\b/i, /^restore\b/i],
  [/^minimi[sz]e\b/i, /^restore\b/i], [/^zoom in\b/i, /^zoom out\b/i], [/^enable\b/i, /^disable\b/i], [/^add\b/i, /^remove\b/i],
]
function counterpart(a: string, b: string): boolean {
  const rest = (s: string, re: RegExp) => s.replace(re, '').replace(/\b(in|out)\b/i, '').trim().toLowerCase()
  return OPPOSITES.some(([p, q]) => (p.test(a) && q.test(b) && rest(a, p) === rest(b, q)) || (q.test(a) && p.test(b) && rest(a, q) === rest(b, p)))
}
/** A control whose label says it leaves: a user would look for it whatever its position. */
const LABELLED_EXIT = /^(close|cancel|dismiss|done|back|undo|restore|ok)\b/i

/** A demo server of its own for each worker: its own port and data folder, so crawls in different workers never share state. */
type Server = { baseURL: string; dataDir: string }
const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port
      s.close(() => resolve(port))
    })
  })
const test = base.extend<object, { server: Server }>({
  server: [
    async ({}, use) => {
      const port = await freePort()
      const dataDir = mkdtempSync(join(tmpdir(), 'explore-audit-'))
      const baseURL = 'http://127.0.0.1:' + port
      const proc = spawn('uv', ['run', 'databricks-explore', '--demo', '--no-browser', '--port', String(port), '--data-dir', dataDir], {
        cwd: fileURLToPath(new URL('../..', import.meta.url)),
        detached: true,
        stdio: 'ignore',
      })
      try {
        const deadline = Date.now() + 120_000
        for (;;) {
          if (proc.exitCode !== null) throw new Error('the demo server exited with code ' + proc.exitCode)
          if (await fetch(baseURL + '/api/profiles').then((r) => r.ok, () => false)) break
          if (Date.now() > deadline) throw new Error('the demo server did not start within 120 s')
          await new Promise((r) => setTimeout(r, 100))
        }
        await use({ baseURL, dataDir })
      } finally {
        try {
          process.kill(-proc.pid!, 'SIGTERM')
        } catch {
          /* already gone */
        }
        rmSync(dataDir, { recursive: true, force: true })
      }
    },
    { scope: 'worker', timeout: 150_000 },
  ],
})

async function crawl(browser: Browser, baseURL: string, dataDir: string, root: string, vp: { width: number; height: number }, order: number) {
  const origin = new URL(baseURL).origin
  const t0 = Date.now()
  const findings = new Map<string, Finding>()
  const crawls: Record<string, unknown>[] = []
  const graphs: Record<string, unknown>[] = []

  async function runCrawl(root: string, vp: { width: number; height: number }) {
    const vpName = vp.width + 'x' + vp.height
    const prefix = root.toLowerCase().replace(/[^a-z]+/g, '-') + '-' + vp.width
    const tStart = Date.now()
    tm = newTiming()
    let ctx: BrowserContext | undefined
    let page!: Page
    let leftApp = false

    // Reset: a fresh browser context (new localStorage, so no draft) and emptied server-side stores, then the root's start state.
    // Everything a click can persist must be wiped: canvases, saved diagrams and the relationship/concept database. Missing one makes
    // every later reset start from a different state (Concepts: one saved concept made the start state differ for the rest of the crawl).
    async function reset(): Promise<Snap> {
      const tR = Date.now()
      try {
        return await resetInner()
      } finally {
        tm.resetMs += Date.now() - tR
        tm.resets++
      }
    }
    async function resetInner(): Promise<Snap> {
      const tW = Date.now()
      await ctx?.close().catch(() => {})
      await new Promise((r) => setTimeout(r, 300)) // a request the closed page left in flight (a saved concept) must land before the wipe, not after it
      for (const d of USER_DATA) {
        try {
          for (const f of readdirSync(join(dataDir, d))) rmSync(join(dataDir, d, f), { recursive: true, force: true })
        } catch {
          /* folder not there yet */
        }
      }
      tm.resetWipeMs += Date.now() - tW
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
    let startSnap: Snap | undefined
    const resetDiffs: string[] = [] // what a failed reset looked like, to find the cause
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
    function report(ruleId: string, control: string, detail: string, dedupe: string, st: { id: string; shot: string; path: Act[] }, occluder?: string, confidence: 'high' | 'low' = 'high') {
      const k = ruleId + '|' + control + '|' + dedupe
      const where = { root, viewport: vpName, stateId: prefix + '-' + st.id }
      const f = findings.get(k)
      if (f) {
        if (!f.where.some((w) => w.root === root && w.viewport === vpName)) f.where.push(where)
        return
      }
      findings.set(k, { ruleId, severity: SEVERITY[ruleId], control, detail, occluder, screenshot: st.shot, repro: reproOf(st.path), confidence, where: [where] })
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
      const tS = Date.now()
      await page.screenshot({ path: join(OUT, shot) }).catch(() => {})
      tm.screenshotMs += Date.now() - tS
      tm.screenshots++
      const state: State = { id, sig: snap.sig, struct: snap.struct, path, depth: path.length, actions: actionsOf(snap), explored: new Set(), shot, controls: snap.controls, off: snap.off, meta: snap.meta, open: snap.open }
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
            if (resetDiffs.length < 5 && startSnap) resetDiffs.push(brief(diffStates(startSnap, s, false)) || 'same controls, different signature')
            ok = false
          } else {
            const tP = Date.now()
            for (const a of state.path)
              if (!(await perform(a))) {
                ok = false
                break
              }
            tm.replayMs += Date.now() - tP
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
      const tA = Date.now()
      const performed = await perform(a)
      tm.actMs += Date.now() - tA
      if (!performed) return void (cur = null)
      if (leftApp) return void (cur = null)
      const snap = await snapshot(page)
      cur = snap.sig === state.sig ? state.id : null
      const to = await discover(snap, [...state.path, a], stateCap)
      if (!to) return
      edges.push({ from: state.id, action: a.key, to, label: a.label })
    }

    // ---- crawl ----
    startSnap = await reset()
    startSig = startSnap.sig
    const first = await reset() // the second reset must give the same start; goTo checks it every time from here on
    if (first.sig !== startSig) throw new Error('the start state of ' + root + ' is not stable across resets: ' + brief(diffStates(startSnap, first, false)))
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
    // "Back at A" means loosely equal: the same apart from selection (aria-selected, selected classes, resize handles) and enabled/disabled flips.
    // Graph nodes stay keyed by the strict signature; only the comparisons with A are loose.
    const equiv = (x: string, y: string) => x === y || states.get(x)!.sig === states.get(y)!.sig || diffStates(states.get(x)!, states.get(y)!, true).length === 0
    const outgoing = (id: string) => edges.filter((e) => e.from === id)
    const reaches = (b: string, a: string): boolean => {
      if (equiv(b, a)) return true
      for (const e1 of outgoing(b)) {
        if (equiv(e1.to, a)) return true
        for (const e2 of outgoing(e1.to)) if (equiv(e2.to, a)) return true
      }
      return false
    }
    const candidates = () => edges.filter((e) => e.from !== e.to && e.action !== 'press|Escape' && !ONE_WAY.test(e.label) && !equiv(e.from, e.to))
    const controlName = (label: string) => /"(.*)"/.exec(label)?.[1] ?? label
    /** Likely ways back out of B first: the same control again (a toggle), its opposite (Hide/Show, Zoom In/Out), Escape, then controls named like an undo. */
    const returnRank = (e: Edge, a: Act) =>
      a.key === e.action ? 0 : counterpart(controlName(e.label), a.name) ? 1 : a.key === 'press|Escape' ? 2 : RETURN_WORDS.test(a.name) || LABELLED_EXIT.test(a.name) ? 3 : 4
    async function tryReturn(e: Edge) {
      const B = states.get(e.to)!
      const order = [...B.actions].sort((x, y) => returnRank(e, x) - returnRank(e, y))
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
    const obscureSearch = { n: 0, max: EXTRA_ACTIONS } // extra actions spent looking for an obvious exit before calling one obscure
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
        report('irreversible-transition', e.label, A.id + ' -> ' + B.id + ': no way back to ' + A.id + ' within 2 actions (tried ' + B.explored.size + ' of ' + B.actions.length + ' actions in ' + B.id + '); ' + B.id + ' differs from ' + A.id + ' by: ' + (brief(diffStates(A, B, true)) || 'nothing visible'), A.struct + '|' + B.struct, B)
        continue
      }
      // A way back exists. Is any of them one a user would find: no Escape, every control visible in A at the same screen position,
      // labelled as an exit (Close, Cancel...) or the opposite of something A shows (Hide X / Show X)?
      const stateOf = (id: string) => states.get(id)!
      const ctlOf = (from: string, ed: Edge) => stateOf(from).controls.find((c) => c.key === ed.action && c.role !== 'label')
      const pathsBack = () => {
        const ps: Edge[][] = []
        for (const e1 of outgoing(B.id)) {
          if (equiv(e1.to, A.id)) ps.push([e1])
          else for (const e2 of outgoing(e1.to)) if (equiv(e2.to, A.id)) ps.push([e1, e2])
        }
        return ps
      }
      // A dialog that A lacked is left through its own buttons (Close, Cancel): those are the expected exit even though A never showed them.
      const dialogOpened = B.open.some((t) => /^dialog:/.test(t) && !A.open.includes(t))
      // A dialog that A had and B closed: the way back is whatever opened it, which a modal hides in A by design.
      const dialogClosed = A.open.some((t) => /^dialog:/.test(t) && !B.open.includes(t))
      const obvious = (p: Edge[]) =>
        p.every((ed, i) => {
          if (ed.action === 'press|Escape') return false
          if (dialogOpened && i === 0) return true
          if (dialogClosed && i === 0) return true
          const c = ctlOf(ed.from, ed)
          if (!c) return false
          return visibleInA(A, c) || LABELLED_EXIT.test(c.name) || A.controls.some((x) => x.role !== 'label' && counterpart(x.name, c.name))
        })
      let paths = pathsBack()
      if (paths.length && !paths.some(obvious)) {
        // The search for a way back stops at the first one it finds, often Escape. Try B's other actions, most likely exits first, before judging.
        for (const a of [...B.actions].sort((x, y) => returnRank(e, x) - returnRank(e, y))) {
          if (paths.some(obvious) || B.explored.size >= PER_STATE_RETURN_TRIES + 6 || obscureSearch.n >= obscureSearch.max) break
          if (B.explored.has(a.key)) continue
          await explore(B, a, obscureSearch, MAX_STATES + 20)
          paths = pathsBack()
        }
      }
      if (paths.length && !paths.some(obvious)) {
        const how = paths[0].map((ed) => ed.label).join(' then ')
        const L = states.get(paths[0][paths[0].length - 1].to)!
        const lands = L.sig === A.sig ? '' : '; it lands in ' + L.id + ', which matches ' + A.id + ' apart from: ' + (brief(diffStates(A, L, false)) || 'nothing visible')
        const unsearched = B.actions.length - B.explored.size
        report(
          'only-obscure-exit', e.label,
          A.id + ' -> ' + B.id + ': the only way back found is "' + how + '", which is Escape or a control that was not visible in ' + A.id + ' at the same position' + lands + (unsearched > 0 ? ' (' + unsearched + ' of ' + B.actions.length + ' actions in ' + B.id + ' not tried, so a better exit may exist)' : ''),
          A.struct + '|' + B.struct, B, undefined, unsearched > 0 ? 'low' : 'high',
        )
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
      const differs = diffStates(A, after, true)
      if (!differs.length) continue // back at A apart from selection (clicking inside a window selects it) and enabled/disabled flips
      const landed = bySig.get(after.sig) ?? (await discover(after, [...B.path, { key: cL.key, label: 'click ' + cL.role + ' "' + cL.name + '" (again)', name: cL.name, role: cL.role }], MAX_STATES + 20))
      const hit = cL.hit ? 'the click at (' + Math.round(x) + ',' + Math.round(y) + ') hit ' + cL.hit : 'the click at (' + Math.round(x) + ',' + Math.round(y) + ') hit the control itself'
      report('toggle-not-undoable', e.label, A.id + ' -> ' + B.id + ' (control is now ' + cL.role + ' "' + cL.name + '"): clicking it again leads ' + (after.sig === B.sig ? 'nowhere (state unchanged)' : 'to ' + (landed ?? 'a new state') + ', not back to ' + A.id) + '; ' + hit + '; the result differs from ' + A.id + ' by: ' + brief(differs), A.struct + '|' + B.struct, B)
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
      if (out && out.to === B.id) report('escape-does-nothing', e.label, 'Escape in ' + B.id + ' (reached from ' + A.id + ') changes nothing, though ' + B.id + ' has ' + B.open.filter((t) => !A.open.includes(t)).join(', ') + ' that ' + A.id + ' lacked (heuristic: not every popup is meant to close on Escape)', A.struct, B, undefined, 'low')
    }

    const seconds = Math.round((Date.now() - tStart) / 1000)
    crawls.push({ root, viewport: vpName, states: states.size, edges: edges.length, actions: actionCount, crawledActions: crawled, resetFailures, replayMismatches, resetDiffs, unverifiedReturns: unverified.length, unverified, seconds, timing: { ...tm, totalMs: Date.now() - tStart } })
    graphs.push({
      root, viewport: vpName,
      states: [...states.values()].map((s) => ({ id: prefix + '-' + s.id, sig: s.sig, depth: s.depth, path: s.path.map((p) => p.label), screenshot: s.shot, actions: s.actions.length, explored: s.explored.size, controls: describeControls(s) })),
      edges: edges.map((e) => ({ ...e, from: prefix + '-' + e.from, to: prefix + '-' + e.to })),
    })
    await ctx?.close().catch(() => {})
    console.log('audit crawl ' + root + ' ' + vpName + ': ' + states.size + ' states, ' + edges.length + ' edges, ' + actionCount + ' actions, ' + unverified.length + ' unverified, ' + seconds + 's')
  }

  await runCrawl(root, vp)
  const part: Part = { order, findings: [...findings.entries()], crawl: crawls[0], graph: graphs[0] }
  mkdirSync(join(OUT, 'parts'), { recursive: true })
  writeFileSync(join(OUT, 'parts', root.toLowerCase().replace(/[^a-z]+/g, '-') + '-' + vp.width + '.json'), JSON.stringify(part))
}

const onlyRoots = (process.env.AUDIT_ROOTS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
const onlyWidths = (process.env.AUDIT_VIEWPORTS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
VIEWPORTS.forEach((vp, vi) =>
  ROOTS.forEach((root, ri) => {
    if ((onlyRoots.length && !onlyRoots.includes(root.toLowerCase())) || (onlyWidths.length && !onlyWidths.includes(String(vp.width)))) return
    test('crawl ' + root + ' at ' + vp.width + 'x' + vp.height, async ({ browser, server }) => {
      await crawl(browser, server.baseURL, server.dataDir, root, vp, vi * ROOTS.length + ri)
    })
  }),
)
