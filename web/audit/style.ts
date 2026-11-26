// Style lint: collects computed styles of the visible elements of a state and, once all crawls are done, turns them into a token
// inventory, near-duplicate / off-scale / row / alignment findings and a style sub-score. Deterministic, no LLM. See README.md.
import type { Page } from '@playwright/test'
import type { Finding } from './report'

export const STYLE_RULES = ['style-near-duplicate', 'style-off-scale', 'style-row-inconsistent', 'style-near-miss-align'] as const
export const STYLE_SEVERITY: Record<string, 'low' | 'info'> = {
  'style-near-duplicate': 'low',
  'style-off-scale': 'low',
  'style-row-inconsistent': 'low',
  'style-near-miss-align': 'low',
}
const STYLE_WEIGHT = { low: 1, info: 0 }
const MAX_PER_RULE = { 'style-near-duplicate': 40, 'style-off-scale': 10, 'style-row-inconsistent': 40, 'style-near-miss-align': 40 }

export type Tok = { n: number; states: number; ex: string[]; s: string } // uses, states it was seen in, example selectors, first state
export type Tokens = Record<string, Record<string, Tok>>
export type Local = { rule: string; key: string; control: string; detail: string; s: string }
export type StateSummary = { elements: number; fontSizes: number; colours: number; spacings: number; radii: number; disabledControls: number }
export type Ref = { id: string; shot: string; repro: string[]; root: string; viewport: string }
export type StylePart = { tokens: Tokens; local: Local[]; states: Record<string, StateSummary>; refs: Record<string, Ref> }
type Raw = {
  tokens: Record<string, Record<string, { n: number; ex: string[] }>>
  summary: StateSummary
  rows: { control: string; kind: string; diffs: string[]; items: string[]; sig: string }[]
  aligns: { control: string; kind: string; total: number; pairs: string[]; sig: string }[]
}

/** Runs in the page: computed styles and boxes of every visible element. Self-contained (it is serialised). */
function collectStyle(): Raw {
  const vw = innerWidth
  const vh = innerHeight
  const tokens: Raw['tokens'] = {}
  const label = (e: Element) => {
    const t = (e.getAttribute('aria-label') || (e.children.length === 0 ? e.textContent : '') || (e as HTMLInputElement).placeholder || '').trim().replace(/\s+/g, ' ')
    return t ? ' "' + t.slice(0, 20) + '"' : ''
  }
  const one = (e: Element) => {
    let s = e.tagName.toLowerCase()
    const t = e.getAttribute('data-testid')
    if (e.id && e.id.length < 30) s += '#' + e.id
    else if (t) s += '[data-testid=' + t + ']'
    else {
      const c = [...e.classList].filter((x) => x.length < 32).slice(0, 2)
      if (c.length) s += '.' + c.join('.')
    }
    return s
  }
  const sel = (e: Element) => {
    const p = e.parentElement
    return (p && p !== document.body ? one(p) + ' > ' : '') + one(e)
  }
  const rec = (prop: string, value: string, e: Element) => {
    const m = (tokens[prop] ??= {})
    const t = (m[value] ??= { n: 0, ex: [] })
    t.n++
    if (t.ex.length < 3) t.ex.push(sel(e))
  }
  const px = (v: string) => parseFloat(v)
  const clear = (c: string) => c === 'rgba(0, 0, 0, 0)' || c === 'transparent'
  const all = [...document.body.getElementsByTagName('*')].slice(0, 6000)
  type Box = { e: Element; l: number; r: number; t: number; b: number; w: number; h: number; cs: CSSStyleDeclaration }
  const boxes = new Map<Element, Box>()
  const CTRL = 'button,input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=range]),select,textarea,[role=button]'
  let disabled = 0
  for (const e of all) {
    if (e.closest('svg') && e.tagName.toLowerCase() !== 'svg') continue
    if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|BR|HEAD|META|LINK)$/.test(e.tagName)) continue
    const cs = getComputedStyle(e)
    if (cs.display === 'none' || cs.visibility !== 'visible' || cs.opacity === '0') continue
    const r = e.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0 || r.right <= 0 || r.bottom <= 0 || r.left >= vw || r.top >= vh) continue
    boxes.set(e, { e, l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height, cs })
    if (e.matches(':disabled,[aria-disabled=true]')) disabled++
    const hasText = [...e.childNodes].some((n) => n.nodeType === 3 && (n.textContent ?? '').trim() !== '')
    if (hasText) {
      rec('fontSize', cs.fontSize, e)
      rec('fontWeight', cs.fontWeight, e)
      rec('lineHeight', cs.lineHeight, e)
      rec('color', cs.color, e)
    }
    if (!clear(cs.backgroundColor)) rec('background', cs.backgroundColor, e)
    for (const side of ['Top', 'Right', 'Bottom', 'Left'] as const) {
      const k = cs as unknown as Record<string, string>
      if (px(k['border' + side + 'Width']) > 0 && k['border' + side + 'Style'] !== 'none' && !clear(k['border' + side + 'Color'])) {
        rec('borderColor', k['border' + side + 'Color'], e)
        break
      }
    }
    const rad = [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius]
    if (rad.some((x) => x !== '0px')) rec('radius', rad.every((x) => x === rad[0]) ? rad[0] : rad.join(' '), e)
    for (const v of [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft]) if (v !== '0px') rec('padding', v, e)
    if (/flex|grid/.test(cs.display)) {
      if (cs.rowGap !== 'normal' && cs.rowGap !== '0px') rec('gap', cs.rowGap, e)
      if (cs.columnGap !== 'normal' && cs.columnGap !== '0px' && cs.columnGap !== cs.rowGap) rec('gap', cs.columnGap, e)
    }
    if (e.matches(CTRL)) rec(/^(INPUT|SELECT|TEXTAREA)$/.test(e.tagName) ? 'inputHeight' : 'buttonHeight', Math.round(r.height * 10) / 10 + 'px', e)
  }

  const flowing = (b: Box) => b.cs.position !== 'absolute' && b.cs.position !== 'fixed' && b.cs.display !== 'inline' && b.cs.display !== 'contents'
  const rows: Raw['rows'] = []
  const aligns: Raw['aligns'] = []
  const near = (d: number) => Math.abs(d) > 0.5 && Math.abs(d) <= 3
  const same = (d: number) => Math.abs(d) <= 0.5
  const f1 = (n: number) => String(Math.round(n * 10) / 10)

  const pairs = (items: Box[], skip?: (a: Box, b: Box) => boolean) => {
    const out: string[] = []
    let total = 0
    for (let i = 0; i < items.length; i++)
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i]
        const b = items[j]
        if (skip?.(a, b)) continue
        const ax = [a.l, a.r, (a.l + a.r) / 2]
        const bx = [b.l, b.r, (b.l + b.r) / 2]
        const ay = [a.t, a.b, (a.t + a.b) / 2]
        const by = [b.t, b.b, (b.t + b.b) / 2]
        const names = [['left', 'right', 'centre-x'], ['top', 'bottom', 'centre-y']]
        for (const [pa, pb, nm] of [[ax, bx, names[0]], [ay, by, names[1]]] as [number[], number[], string[]][]) {
          if (pa.some((v, k) => same(v - pb[k]))) continue // aligned on this axis by some edge
          for (const k of [0, 2, 1]) {
            if (nm[k] === 'bottom') continue
            const d = pa[k] - pb[k]
            if (near(d)) {
              total++
              if (out.length < 6) out.push(a.e.tagName.toLowerCase() + label(a.e) + ' / ' + b.e.tagName.toLowerCase() + label(b.e) + ': ' + nm[k] + ' differs by ' + f1(Math.abs(d)) + 'px')
            }
          }
        }
      }
    return { out, total }
  }

  for (const [p, pb] of boxes) {
    const kids = [...p.children].map((c) => boxes.get(c)).filter((b): b is Box => !!b && flowing(b))
    if (kids.length < 2 || kids.length > 40) continue
    const pc = sel(p)
    // controls in one row
    for (const kind of ['button', 'input']) {
      const cs = kids.filter((b) => b.e.matches(CTRL) && (/^(INPUT|SELECT|TEXTAREA)$/.test(b.e.tagName) ? 'input' : 'button') === kind)
      if (cs.length < 2) continue
      let best: Box[] = []
      for (const c of cs) {
        const row = cs.filter((o) => Math.abs((o.t + o.b) / 2 - (c.t + c.b) / 2) <= 4)
        if (row.length > best.length) best = row
      }
      if (best.length < 2) continue
      const hs = best.map((b) => b.h)
      const fs = best.map((b) => px(b.cs.fontSize))
      const rs = best.map((b) => b.cs.borderTopLeftRadius)
      const diffs: string[] = []
      if (Math.max(...hs) - Math.min(...hs) >= 1) diffs.push('height ' + [...new Set(hs.map(f1))].join('/') + 'px')
      if (Math.max(...fs) - Math.min(...fs) >= 0.5) diffs.push('font-size ' + [...new Set(fs.map(f1))].join('/') + 'px')
      if (new Set(rs).size > 1) diffs.push('radius ' + [...new Set(rs)].join('/'))
      if (diffs.length)
        rows.push({ control: pc, kind, diffs, items: best.slice(0, 6).map((b) => one(b.e) + label(b.e) + ' ' + f1(b.h) + 'px ' + b.cs.fontSize + ' r' + b.cs.borderTopLeftRadius), sig: best.map((b) => f1(b.h) + b.cs.fontSize + b.cs.borderTopLeftRadius).join(',') })
    }
    // near-miss alignment among siblings
    const big = kids.filter((b) => b.w >= 6 && b.h >= 6)
    if (big.length >= 2) {
      const r = pairs(big)
      if (r.total) aligns.push({ control: pc, kind: 'sibling', total: r.total, pairs: r.out, sig: r.out.map((s) => s.replace(/"[^"]*"/g, '')).join('|') })
    }
    // cousins: same-looking grandchildren of different children
    const groups = new Map<string, Box[]>()
    for (const k of big)
      for (const g of [...k.e.children]) {
        const gb = boxes.get(g)
        if (!gb || !flowing(gb) || gb.w < 6 || gb.h < 6) continue
        const sig = g.tagName + '.' + [...g.classList].sort().join('.')
        const l = groups.get(sig) ?? []
        l.push(gb)
        groups.set(sig, l)
      }
    for (const list of groups.values()) {
      if (list.length < 2 || list.length > 30 || new Set(list.map((b) => b.e.parentElement)).size < 2) continue
      const r = pairs(list, (a, b) => a.e.parentElement === b.e.parentElement)
      if (r.total) aligns.push({ control: pc, kind: 'cousin', total: r.total, pairs: r.out, sig: 'c' + r.out.map((s) => s.replace(/"[^"]*"/g, '')).join('|') })
    }
  }

  const keys = (...ps: string[]) => new Set(ps.flatMap((p) => Object.keys(tokens[p] ?? {}))).size
  return {
    tokens,
    summary: { elements: boxes.size, fontSizes: keys('fontSize'), colours: keys('color', 'background', 'borderColor'), spacings: keys('padding', 'gap', 'siblingGap'), radii: keys('radius'), disabledControls: disabled },
    rows,
    aligns,
  }
}

/** Gaps between adjacent siblings need the sibling boxes of the whole page; collected in a second small pass inside the same evaluate. */
function collectSiblingGaps(): Record<string, { n: number; ex: string[] }> {
  const out: Record<string, { n: number; ex: string[] }> = {}
  const vw = innerWidth
  const vh = innerHeight
  const nm = (e: Element) => {
    const c = [...e.classList].filter((x) => x.length < 32).slice(0, 2)
    return e.tagName.toLowerCase() + (c.length ? '.' + c.join('.') : '')
  }
  for (const p of [...document.body.getElementsByTagName('*')].slice(0, 6000)) {
    if (p.closest('svg') || p.children.length < 2 || p.children.length > 30) continue
    const pcs = getComputedStyle(p)
    if (pcs.display === 'none' || /^space|^center/.test(pcs.justifyContent) || (/flex|grid/.test(pcs.display) && pcs.rowGap !== 'normal' && pcs.rowGap !== '0px')) continue
    const kids: { e: Element; r: DOMRect }[] = []
    for (const c of p.children) {
      const cs = getComputedStyle(c)
      if (cs.display === 'none' || cs.display === 'inline' || cs.display === 'contents' || cs.position === 'absolute' || cs.position === 'fixed' || cs.visibility !== 'visible') continue
      const r = c.getBoundingClientRect()
      if (r.width <= 0 || r.height <= 0 || r.right <= 0 || r.bottom <= 0 || r.left >= vw || r.top >= vh) continue
      kids.push({ e: c, r })
    }
    for (let i = 1; i < kids.length; i++) {
      const a = kids[i - 1].r
      const b = kids[i].r
      const vo = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
      const ho = Math.min(a.right, b.right) - Math.max(a.left, b.left)
      let g = NaN
      if (vo > 0.5 * Math.min(a.height, b.height) && b.left >= a.right - 0.5) g = b.left - a.right
      else if (ho > 0.5 * Math.min(a.width, b.width) && b.top >= a.bottom - 0.5) g = b.top - a.bottom
      if (!(g > 0.5 && g <= 64)) continue
      const v = Math.round(g) + 'px'
      const t = (out[v] ??= { n: 0, ex: [] })
      t.n++
      if (t.ex.length < 3) t.ex.push(nm(p) + ' > ' + nm(kids[i].e))
    }
  }
  return out
}

/** Per-crawl accumulator: the crawler calls visit() once per new state and part() when the crawl ends. */
export class StyleAcc {
  tokens: Tokens = {}
  local = new Map<string, Local>()
  states: Record<string, StateSummary> = {}
  refs: Record<string, Ref> = {}
  /** Collects the style of the page as it is now; returns the milliseconds spent. */
  async visit(page: Page, ref: Ref): Promise<number> {
    const t = Date.now()
    try {
      const [raw, gaps] = await Promise.all([page.evaluate(collectStyle), page.evaluate(collectSiblingGaps)])
      raw.tokens.siblingGap = gaps
      raw.summary.spacings = new Set(['padding', 'gap', 'siblingGap'].flatMap((p) => Object.keys(raw.tokens[p] ?? {}))).size
      for (const [prop, vals] of Object.entries(raw.tokens)) {
        const m = (this.tokens[prop] ??= {})
        for (const [v, x] of Object.entries(vals)) {
          const k = (m[v] ??= { n: 0, states: 0, ex: [], s: ref.id })
          k.n += x.n
          k.states++
          for (const e of x.ex) if (k.ex.length < 3 && !k.ex.includes(e)) k.ex.push(e)
        }
      }
      this.states[ref.id] = raw.summary
      this.refs[ref.id] = ref
      for (const r of raw.rows) {
        const key = 'style-row-inconsistent|' + r.control + '|' + r.kind
        if (!this.local.has(key)) this.local.set(key, { rule: 'style-row-inconsistent', key, control: r.control + ' (' + r.kind + 's in a row)', detail: r.kind + 's in one row differ in ' + r.diffs.join(', ') + ': ' + r.items.join('; '), s: ref.id })
      }
      for (const a of raw.aligns) {
        const key = 'style-near-miss-align|' + a.control + '|' + a.kind
        if (!this.local.has(key))
          this.local.set(key, { rule: 'style-near-miss-align', key, control: a.control + ' (' + a.kind + 's)', detail: a.total + ' ' + a.kind + ' pair(s) miss alignment by 1-3px, e.g. ' + a.pairs.join('; '), s: ref.id })
      }
    } catch {
      // a page that cannot be measured (navigating away) just has no style data
    }
    return Date.now() - t
  }
  part(): StylePart {
    return { tokens: this.tokens, local: [...this.local.values()], states: this.states, refs: this.refs }
  }
}

// ---- colour distance (CIEDE2000) ----
type RGBA = [number, number, number, number]
export function parseColor(c: string): RGBA | null {
  let m = /^rgba?\(([^)]+)\)$/.exec(c)
  if (m) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number)
    return p.length >= 3 && p.every((x) => !Number.isNaN(x)) ? [p[0], p[1], p[2], p[3] ?? 1] : null
  }
  m = /^color\(srgb ([^)]+)\)$/.exec(c)
  if (m) {
    const p = m[1].split(/[\s/]+/).filter(Boolean).map(Number)
    return p.length >= 3 && p.every((x) => !Number.isNaN(x)) ? [p[0] * 255, p[1] * 255, p[2] * 255, p[3] ?? 1] : null
  }
  return null
}
function lab([r, g, b]: RGBA): [number, number, number] {
  const lin = (v: number) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
  const [R, G, B] = [lin(r), lin(g), lin(b)]
  const X = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047
  const Y = 0.2126729 * R + 0.7151522 * G + 0.072175 * B
  const Z = (0.0193339 * R + 0.119192 * G + 0.9503041 * B) / 1.08883
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116)
  return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))]
}
export function deltaE2000(c1: RGBA, c2: RGBA): number {
  const [L1, a1, b1] = lab(c1)
  const [L2, a2, b2] = lab(c2)
  const rad = Math.PI / 180
  const C1 = Math.hypot(a1, b1)
  const C2 = Math.hypot(a2, b2)
  const Cb = (C1 + C2) / 2
  const G = 0.5 * (1 - Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)))
  const a1p = (1 + G) * a1
  const a2p = (1 + G) * a2
  const C1p = Math.hypot(a1p, b1)
  const C2p = Math.hypot(a2p, b2)
  const hp = (b: number, a: number) => (b === 0 && a === 0 ? 0 : ((Math.atan2(b, a) / rad) + 360) % 360)
  const h1p = hp(b1, a1p)
  const h2p = hp(b2, a2p)
  const dLp = L2 - L1
  const dCp = C2p - C1p
  let dhp = 0
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p
    if (dhp > 180) dhp -= 360
    else if (dhp < -180) dhp += 360
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp * rad) / 2)
  const Lbp = (L1 + L2) / 2
  const Cbp = (C1p + C2p) / 2
  let hbp = h1p + h2p
  if (C1p * C2p !== 0) hbp = Math.abs(h1p - h2p) <= 180 ? (h1p + h2p) / 2 : h1p + h2p < 360 ? (h1p + h2p + 360) / 2 : (h1p + h2p - 360) / 2
  const T = 1 - 0.17 * Math.cos((hbp - 30) * rad) + 0.24 * Math.cos(2 * hbp * rad) + 0.32 * Math.cos((3 * hbp + 6) * rad) - 0.2 * Math.cos((4 * hbp - 63) * rad)
  const dTh = 30 * Math.exp(-(((hbp - 275) / 25) ** 2))
  const Rc = 2 * Math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7))
  const Sl = 1 + (0.015 * (Lbp - 50) ** 2) / Math.sqrt(20 + (Lbp - 50) ** 2)
  const Sc = 1 + 0.045 * Cbp
  const Sh = 1 + 0.015 * Cbp * T
  const Rt = -Math.sin(2 * dTh * rad) * Rc
  return Math.sqrt((dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh))
}

// ---- merge ----
const COLOUR_PROPS = ['color', 'background', 'borderColor']
const SPACING_PROPS = ['padding', 'gap', 'siblingGap']
const PROPS = ['fontSize', 'fontWeight', 'lineHeight', 'color', 'background', 'borderColor', 'radius', 'padding', 'gap', 'siblingGap', 'buttonHeight', 'inputHeight']
type Pooled = { value: string; n: number; states: number; ex: string[]; s: string; props: Set<string> }

function pool(tokens: Tokens, props: string[]): Map<string, Pooled> {
  const out = new Map<string, Pooled>()
  for (const p of props)
    for (const [v, t] of Object.entries(tokens[p] ?? {})) {
      const o = out.get(v) ?? { value: v, n: 0, states: 0, ex: [], s: t.s, props: new Set<string>() }
      o.n += t.n
      o.states += t.states
      for (const e of t.ex) if (o.ex.length < 3 && !o.ex.includes(e)) o.ex.push(e)
      o.props.add(p)
      out.set(v, o)
    }
  return out
}

export type StyleFinding = Finding & { category: 'style' }

/** Combines the style parts of all crawls into the "style" section of ui-findings.json and the style findings. */
export function mergeStyle(parts: StylePart[]) {
  const tokens: Tokens = {}
  const refs: Record<string, Ref> = {}
  const states: Record<string, StateSummary> = {}
  for (const p of parts) {
    Object.assign(refs, p.refs)
    Object.assign(states, p.states)
    for (const [prop, vals] of Object.entries(p.tokens)) {
      const m = (tokens[prop] ??= {})
      for (const [v, x] of Object.entries(vals)) {
        const k = (m[v] ??= { n: 0, states: 0, ex: [], s: x.s })
        k.n += x.n
        k.states += x.states
        for (const e of x.ex) if (k.ex.length < 3 && !k.ex.includes(e)) k.ex.push(e)
      }
    }
  }
  const inventory: Record<string, { distinct: number; uses: number; values: { value: string; uses: number; states: number; examples: string[] }[] }> = {}
  for (const prop of PROPS) {
    const vals = Object.entries(tokens[prop] ?? {}).sort((a, b) => b[1].n - a[1].n)
    inventory[prop] = { distinct: vals.length, uses: vals.reduce((n, [, t]) => n + t.n, 0), values: vals.map(([value, t]) => ({ value, uses: t.n, states: t.states, examples: t.ex })) }
  }
  const colours = pool(tokens, COLOUR_PROPS)
  const spacings = pool(tokens, SPACING_PROPS)
  const distinct = { fontSizes: inventory.fontSize.distinct, colours: colours.size, radii: inventory.radius.distinct, spacings: spacings.size }

  const findings = new Map<string, StyleFinding>()
  const add = (rule: string, control: string, detail: string, s: string[], extra = {}) => {
    const k = rule + '|' + control
    if (findings.has(k)) return
    const st = s.map((id) => refs[id]).filter(Boolean)
    const first = st[0]
    const where = [...new Map(st.map((r) => [r.root + r.viewport, { root: r.root, viewport: r.viewport, stateId: r.id }])).values()]
    findings.set(k, { ruleId: rule, severity: STYLE_SEVERITY[rule], control, detail, screenshot: first?.shot ?? '', repro: first?.repro ?? [], confidence: 'high', where, category: 'style', ...extra })
  }
  const desc = (p: Pooled) => p.value + ' (' + p.n + ' uses in ' + p.states + ' states; e.g. ' + p.ex.slice(0, 2).join(', ') + ')'
  const merge = (a: Pooled, b: Pooled): [Pooled, Pooled] => (a.n >= b.n ? [a, b] : [b, a]) // [keep, fold]
  const dupes: { rule: string; control: string; detail: string; s: string[]; weight: number }[] = []
  const nearPairs = (items: Pooled[], close: (a: Pooled, b: Pooled) => boolean, what: string) => {
    for (let i = 0; i < items.length; i++)
      for (let j = i + 1; j < items.length; j++) {
        if (!close(items[i], items[j])) continue
        const [keep, fold] = merge(items[i], items[j])
        dupes.push({ rule: 'style-near-duplicate', control: what + ' ' + keep.value + ' vs ' + fold.value, detail: what + ' ' + desc(keep) + ' and ' + desc(fold) + ' are nearly the same; merge ' + fold.value + ' into ' + keep.value + ', the more common', s: [keep.s, fold.s], weight: keep.n + fold.n })
      }
  }
  const pxv = (p: Pooled) => parseFloat(p.value)
  const isPx = (p: Pooled) => /^-?[\d.]+px$/.test(p.value)
  nearPairs([...pool(tokens, ['fontSize']).values()].filter(isPx), (a, b) => Math.abs(pxv(a) - pxv(b)) <= 1.0001, 'font-size')
  nearPairs([...pool(tokens, ['radius']).values()].filter((p) => isPx(p) && pxv(p) < 100), (a, b) => Math.abs(pxv(a) - pxv(b)) <= 1.0001, 'radius')
  nearPairs([...spacings.values()].filter((p) => isPx(p) && pxv(p) > 2), (a, b) => Math.abs(pxv(a) - pxv(b)) <= 1.0001, 'spacing')
  const cols = [...colours.values()].map((p) => ({ p, c: parseColor(p.value) })).filter((x): x is { p: Pooled; c: RGBA } => !!x.c && x.c[3] >= 0.05)
  for (let i = 0; i < cols.length; i++)
    for (let j = i + 1; j < cols.length; j++) {
      if (Math.abs(cols[i].c[3] - cols[j].c[3]) > 0.05) continue
      const de = deltaE2000(cols[i].c, cols[j].c)
      if (de >= 3) continue
      const [keep, fold] = merge(cols[i].p, cols[j].p)
      dupes.push({ rule: 'style-near-duplicate', control: 'colour ' + keep.value + ' vs ' + fold.value, detail: 'colour ' + desc(keep) + ' [' + [...keep.props].join('/') + '] and ' + desc(fold) + ' [' + [...fold.props].join('/') + '] differ by deltaE ' + de.toFixed(1) + '; merge ' + fold.value + ' into ' + keep.value + ', the more common', s: [keep.s, fold.s], weight: keep.n + fold.n })
    }
  dupes.sort((a, b) => b.weight - a.weight)
  for (const d of dupes.slice(0, MAX_PER_RULE['style-near-duplicate'])) add(d.rule, d.control, d.detail, d.s)

  // off-scale spacing: declared padding and gap values not on the 4px grid (0, 1, 2 allowed)
  const off: { prop: string; value: string; n: number; states: number; ex: string[]; s: string }[] = []
  for (const prop of ['padding', 'gap'])
    for (const [value, t] of Object.entries(tokens[prop] ?? {})) {
      const v = parseFloat(value)
      if (Number.isNaN(v) || [0, 1, 2].includes(v) || v % 4 === 0) continue
      off.push({ prop, value, n: t.n, states: t.states, ex: t.ex, s: t.s })
    }
  off.sort((a, b) => b.n - a.n)
  for (const o of off.slice(0, MAX_PER_RULE['style-off-scale']))
    add('style-off-scale', o.prop + ' ' + o.value, o.prop + ' ' + o.value + ' is off the 4px grid: ' + o.n + ' uses in ' + o.states + ' states; e.g. ' + o.ex.join(', '), [o.s])

  // local findings (rows, alignment), grouped by container already
  const local = new Map<string, Local>()
  for (const p of parts) for (const l of p.local) if (!local.has(l.key)) local.set(l.key, l)
  const counts: Record<string, number> = {}
  for (const l of local.values()) {
    counts[l.rule] = (counts[l.rule] ?? 0) + 1
    if (counts[l.rule] <= MAX_PER_RULE[l.rule as keyof typeof MAX_PER_RULE]) add(l.rule, l.control, l.detail, [l.s])
  }
  // every state where a local finding's key was seen counts as where
  const list = [...findings.values()]
  const byRule: Record<string, number> = {}
  let total = 0
  for (const f of list) {
    byRule[f.ruleId] = (byRule[f.ruleId] ?? 0) + 1
    total += STYLE_WEIGHT[f.severity as 'low' | 'info']
  }
  const all: Record<string, number> = { 'style-near-duplicate': dupes.length, 'style-off-scale': off.length, ...counts }
  const stateList = Object.entries(states)
  const avg = (k: keyof StateSummary) => (stateList.length ? Math.round((stateList.reduce((n, [, s]) => n + s[k], 0) / stateList.length) * 10) / 10 : 0)
  const score = Math.round(100 * Math.exp(-total / 50))
  const section = {
    summary: { score, weightedCauses: total, findingsByRule: byRule, candidatesByRule: all, distinct, states: stateList.length, perStateAverage: { fontSizes: avg('fontSizes'), colours: avg('colours'), spacings: avg('spacings'), radii: avg('radii'), disabledControls: avg('disabledControls') } },
    tokens: inventory,
    colours: { distinct: colours.size, values: [...colours.values()].sort((a, b) => b.n - a.n).map((p) => ({ value: p.value, uses: p.n, props: [...p.props], examples: p.ex })) },
    spacings: { distinct: spacings.size, values: [...spacings.values()].sort((a, b) => b.n - a.n).map((p) => ({ value: p.value, uses: p.n, props: [...p.props] })) },
    offScale: off.slice(0, 25),
    perState: Object.fromEntries(stateList),
  }
  return { section, findings: list }
}
