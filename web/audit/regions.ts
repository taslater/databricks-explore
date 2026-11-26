// Region-separation rule: adjacent major regions must be visually separable. See README.md.
import type { Page } from '@playwright/test'

export type RegionIssue = { a: string; b: string; kind: 'adjacent' | 'nested'; dE: number; detail: string }

/** Runs in the page (self-contained, it is serialised): every pair of adjacent or nested regions that fail to separate. */
function collectRegions(): RegionIssue[] {
  type C = [number, number, number, number]
  const MIN_DE = 2 // background difference that counts as a separation
  const parse = (s: string): C | null => {
    let m = /^rgba?\(([^)]+)\)$/.exec(s)
    if (m) {
      const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number)
      return p.length >= 3 && p.every((x) => !Number.isNaN(x)) ? [p[0], p[1], p[2], p[3] ?? 1] : null
    }
    m = /^color\(srgb ([^)]+)\)$/.exec(s)
    if (m) {
      const p = m[1].split(/[\s/]+/).filter(Boolean).map(Number)
      return p.length >= 3 && p.every((x) => !Number.isNaN(x)) ? [p[0] * 255, p[1] * 255, p[2] * 255, p[3] ?? 1] : null
    }
    return null
  }
  const over = (top: C, under: C): C => {
    const a = top[3] + under[3] * (1 - top[3])
    if (a <= 0) return [0, 0, 0, 0]
    const ch = (i: number) => (top[i] * top[3] + under[i] * under[3] * (1 - top[3])) / a
    return [ch(0), ch(1), ch(2), a]
  }
  const hex = (c: C) => '#' + [c[0], c[1], c[2]].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')
  // CIEDE2000 between two sRGB colours.
  const lab = ([r, g, b]: C) => {
    const f = (v: number) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
    const [R, G, B] = [f(r), f(g), f(b)]
    const xyz = [(0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047, 0.2126729 * R + 0.7151522 * G + 0.072175 * B, (0.0193339 * R + 0.119192 * G + 0.9503041 * B) / 1.08883]
    const t = (v: number) => (v > 216 / 24389 ? Math.cbrt(v) : (24389 / 27 * v + 16) / 116)
    const [fx, fy, fz] = xyz.map(t)
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]
  }
  const deltaE = (c1: C, c2: C) => {
    const [L1, a1, b1] = lab(c1)
    const [L2, a2, b2] = lab(c2)
    const rad = Math.PI / 180
    const C1 = Math.hypot(a1, b1)
    const C2 = Math.hypot(a2, b2)
    const Cm = (C1 + C2) / 2
    const G = 0.5 * (1 - Math.sqrt(Cm ** 7 / (Cm ** 7 + 25 ** 7)))
    const ap1 = (1 + G) * a1
    const ap2 = (1 + G) * a2
    const Cp1 = Math.hypot(ap1, b1)
    const Cp2 = Math.hypot(ap2, b2)
    const hp = (b: number, a: number) => (b === 0 && a === 0 ? 0 : ((Math.atan2(b, a) / rad) + 360) % 360)
    const h1 = hp(b1, ap1)
    const h2 = hp(b2, ap2)
    const dL = L2 - L1
    const dC = Cp2 - Cp1
    let dh = 0
    if (Cp1 * Cp2 !== 0) {
      dh = h2 - h1
      if (dh > 180) dh -= 360
      else if (dh < -180) dh += 360
    }
    const dH = 2 * Math.sqrt(Cp1 * Cp2) * Math.sin((dh * rad) / 2)
    const Lm = (L1 + L2) / 2
    const Cpm = (Cp1 + Cp2) / 2
    let hm = h1 + h2
    if (Cp1 * Cp2 === 0) hm = h1 + h2
    else if (Math.abs(h1 - h2) <= 180) hm = (h1 + h2) / 2
    else hm = (h1 + h2 + (h1 + h2 < 360 ? 360 : -360)) / 2
    const T = 1 - 0.17 * Math.cos((hm - 30) * rad) + 0.24 * Math.cos(2 * hm * rad) + 0.32 * Math.cos((3 * hm + 6) * rad) - 0.2 * Math.cos((4 * hm - 63) * rad)
    const dTheta = 30 * Math.exp(-(((hm - 275) / 25) ** 2))
    const Rc = 2 * Math.sqrt(Cpm ** 7 / (Cpm ** 7 + 25 ** 7))
    const Sl = 1 + (0.015 * (Lm - 50) ** 2) / Math.sqrt(20 + (Lm - 50) ** 2)
    const Sc = 1 + 0.045 * Cpm
    const Sh = 1 + 0.015 * Cpm * T
    const Rt = -Math.sin(2 * dTheta * rad) * Rc
    return Math.sqrt((dL / Sl) ** 2 + (dC / Sc) ** 2 + (dH / Sh) ** 2 + Rt * (dC / Sc) * (dH / Sh))
  }
  const dark = /dark/.test(getComputedStyle(document.documentElement).colorScheme)
  const PAGE: C = dark ? [18, 18, 18, 1] : [255, 255, 255, 1]
  /** The opaque colour an element shows its content on: its own and its ancestors' backgrounds blended until one is opaque. */
  const effective = (e: Element | null): C => {
    const layers: C[] = []
    for (let n: Element | null = e; n; n = n.parentElement) {
      const c = parse(getComputedStyle(n).backgroundColor)
      if (c && c[3] > 0) {
        layers.push(c)
        if (c[3] >= 1) break
      }
    }
    let acc: C = PAGE
    for (let i = layers.length - 1; i >= 0; i--) acc = over(layers[i], acc)
    return acc
  }
  const SEL = 'header,nav,aside,main,[role=region],[role=dialog],[role=banner],[role=navigation],[role=complementary],[role=main],.react-flow__pane,.react-flow__node,[data-region]'
  const vw = innerWidth
  const vh = innerHeight
  const shown = (e: Element) => {
    const r = e.getBoundingClientRect()
    const s = getComputedStyle(e)
    return r.width >= 24 && r.height >= 24 && r.right > 0 && r.bottom > 0 && r.left < vw && r.top < vh && s.visibility === 'visible' && s.display !== 'none' && Number(s.opacity) > 0 && !e.closest('[aria-hidden=true],[inert]')
  }
  const isNode = (e: Element) => e.classList.contains('react-flow__node')
  const nameOf = (e: Element) => {
    if (isNode(e)) return 'react-flow node [' + ([...e.classList].find((c) => c.startsWith('react-flow__node-'))?.slice(17) || e.getAttribute('data-region') || 'default') + ']'
    if (e.classList.contains('react-flow__pane')) return 'react-flow canvas pane'
    const dr = e.getAttribute('data-region')
    const lab = e.getAttribute('aria-label')
    const role = e.getAttribute('role')
    return e.tagName.toLowerCase() + (role ? '[role=' + role + ']' : '') + (dr ? '[data-region=' + dr + ']' : '') + (lab ? ' "' + lab + '"' : '')
  }
  /** What a region looks like: its own background, borders and shadow, or those of the one box inside it that fills it (a React Flow node is a bare wrapper around its card). */
  const visual = (e: Element) => {
    let v: Element = e
    for (let d = 0; d < 4; d++) {
      const s = getComputedStyle(v)
      const bare = (parse(s.backgroundColor)?.[3] ?? 0) === 0 && s.boxShadow === 'none' && ['Top', 'Right', 'Bottom', 'Left'].every((k) => parseFloat(s.getPropertyValue('border-' + k.toLowerCase() + '-width')) === 0)
      if (!bare) break
      const r = v.getBoundingClientRect()
      const kid = [...v.children].find((k) => {
        const kr = k.getBoundingClientRect()
        return Math.abs(kr.width - r.width) <= 4 && Math.abs(kr.height - r.height) <= 4
      })
      if (!kid) break
      v = kid
    }
    return v
  }
  const regions = [...document.querySelectorAll(SEL)].filter(shown).slice(0, 80)
  const set = new Set(regions)
  const issues: RegionIssue[] = []
  const seen = new Set<string>()
  const SIDES = ['top', 'right', 'bottom', 'left'] as const
  /** Does the box set itself apart? Returns what it has: a border on the given sides in a colour unlike both backgrounds, or a shadow. */
  const edge = (el: Element, sides: readonly (typeof SIDES)[number][], bgs: C[]) => {
    const s = getComputedStyle(el)
    const out: string[] = []
    for (const k of sides) {
      const w = parseFloat(s.getPropertyValue('border-' + k + '-width'))
      const style = s.getPropertyValue('border-' + k + '-style')
      const c = parse(s.getPropertyValue('border-' + k + '-color'))
      if (w >= 1 && style !== 'none' && style !== 'hidden' && c) {
        const col = over(c, bgs[0])
        if (bgs.every((b) => deltaE(col, b) >= MIN_DE)) out.push(w + 'px ' + hex(col) + ' ' + k + ' border')
      }
    }
    if (s.boxShadow !== 'none') out.push('box-shadow')
    return out
  }
  const check = (a: Element, b: Element, kind: 'adjacent' | 'nested', facing: [readonly (typeof SIDES)[number][], readonly (typeof SIDES)[number][]]) => {
    const va = visual(a)
    const vb = kind === 'nested' ? b : visual(b)
    // For a nested pair, a is the inner box and b the region around it (what shows behind a).
    const ca = over(parse(getComputedStyle(va).backgroundColor) ?? [0, 0, 0, 0], effective(va.parentElement))
    const cb = effective(vb)
    const dE = deltaE(ca, cb)
    if (dE >= MIN_DE) return
    const has = [...edge(va, facing[0], [ca, cb]), ...(kind === 'adjacent' ? edge(vb, facing[1], [ca, cb]) : [])]
    if (has.length) return
    const na = nameOf(a)
    const nb = nameOf(b)
    const key = [na, nb].sort().join(' | ') + '|' + kind
    if (seen.has(key)) return
    seen.add(key)
    issues.push({ a: na, b: nb, kind, dE: Math.round(dE * 10) / 10, detail: na + ' background ' + hex(ca) + ' and ' + nb + ' ' + hex(cb) + ': deltaE ' + (Math.round(dE * 10) / 10) + ' (needs ' + MIN_DE + '), no border on the shared edge that differs from both, no box-shadow' })
  }
  // Nested: a region against the region it sits in.
  for (const r of regions) {
    let p: Element | null = r.parentElement
    while (p && !set.has(p)) p = p.parentElement
    // A box that fills its region (the React Flow pane inside the workspace) is the same region, not a neighbour to set apart.
    const fills = (c: Element, o: Element) => {
      const rc = c.getBoundingClientRect()
      const ro = o.getBoundingClientRect()
      return rc.width * rc.height >= 0.7 * ro.width * ro.height
    }
    if (p && !fills(r, p)) check(r, p, 'nested', [SIDES, SIDES])
  }
  // Adjacent: neither contains the other, a gap of at most 8px (a resize handle) and a shared edge of at least 24px.
  for (let i = 0; i < regions.length; i++)
    for (let j = i + 1; j < regions.length; j++) {
      const a = regions[i]
      const b = regions[j]
      if (a.contains(b) || b.contains(a) || (isNode(a) && isNode(b))) continue
      const ra = a.getBoundingClientRect()
      const rb = b.getBoundingClientRect()
      const ox = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left)
      const oy = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top)
      const gx = -ox
      const gy = -oy
      if (oy >= 24 && gx >= -1 && gx <= 8) check(a, b, 'adjacent', ra.left < rb.left ? [['right'], ['left']] : [['left'], ['right']])
      else if (ox >= 24 && gy >= -1 && gy <= 8) check(a, b, 'adjacent', ra.top < rb.top ? [['bottom'], ['top']] : [['top'], ['bottom']])
    }
  return issues
}

/** Region-separation issues of the page as it is now ([] when the page cannot be measured). */
export async function regionIssues(page: Page): Promise<RegionIssue[]> {
  try {
    return await page.evaluate(collectRegions)
  } catch {
    return []
  }
}
