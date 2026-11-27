// Surface-order rule: regions declare an elevation role in data-surface, and the measured backgrounds must follow one order. See README.md.
import type { Page } from '@playwright/test'

export type SurfaceSample = { role: string; bg: string; lum: number; area: number; name: string }
export type SurfaceResult = { samples: SurfaceSample[]; issues: { control: string; detail: string }[]; missing: string[] }

/** Runs in the page (self-contained, it is serialised): the declared surfaces with their measured backgrounds, and large regions that declare none. */
function collectSurfaces(): SurfaceResult {
  type C = [number, number, number, number]
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
  const dark = /dark/.test(getComputedStyle(document.documentElement).colorScheme)
  const PAGE: C = dark ? [18, 18, 18, 1] : [255, 255, 255, 1]
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
  const lumOf = ([r, g, b]: C) => {
    const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
  }
  const hex = (c: C) => '#' + [c[0], c[1], c[2]].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')
  const vw = innerWidth
  const vh = innerHeight
  const shown = (e: Element) => {
    const r = e.getBoundingClientRect()
    const s = getComputedStyle(e)
    return r.width >= 24 && r.height >= 24 && r.right > 0 && r.bottom > 0 && r.left < vw && r.top < vh && s.visibility === 'visible' && s.display !== 'none' && Number(s.opacity) > 0 && !e.closest('[aria-hidden=true],[inert]')
  }
  const nameOf = (e: Element) => e.tagName.toLowerCase() + (e.getAttribute('aria-label') ? ' "' + e.getAttribute('aria-label') + '"' : '') + ((e as HTMLElement).className && typeof (e as HTMLElement).className === 'string' ? '.' + (e as HTMLElement).className.trim().split(/\s+/)[0] : '')
  const ROLES = ['base', 'recessed', 'raised', 'overlay']
  const samples: SurfaceSample[] = []
  for (const e of document.querySelectorAll('[data-surface]')) {
    const role = e.getAttribute('data-surface') ?? ''
    if (!ROLES.includes(role) || !shown(e)) continue
    if (e.closest('[aria-selected=true],.selected,.is-selected')) continue // a selected card is tinted on purpose: selection is not a surface
    const r = e.getBoundingClientRect()
    const c = effective(e)
    samples.push({ role, bg: hex(c), lum: lumOf(c), area: Math.round(Math.min(r.right, vw) - Math.max(r.left, 0)) * Math.round(Math.min(r.bottom, vh) - Math.max(r.top, 0)), name: nameOf(e) })
  }
  // The colour of a role in this view: the one that covers most of it.
  const dom = new Map<string, SurfaceSample>()
  const byColour = new Map<string, number>()
  for (const s of samples) byColour.set(s.role + s.bg, (byColour.get(s.role + s.bg) ?? 0) + s.area)
  for (const s of samples) {
    const d = dom.get(s.role)
    if (!d || (byColour.get(s.role + s.bg) ?? 0) > (byColour.get(s.role + d.bg) ?? 0)) dom.set(s.role, s)
  }
  const EPS = 0.002
  const issues: { control: string; detail: string }[] = []
  const d = (r: string) => dom.get(r)
  const say = (s: SurfaceSample) => s.role + ' ' + s.bg + ' (' + s.name + ')'
  const base = d('base')
  const raised = d('raised')
  const overlay = d('overlay')
  const recessed = d('recessed')
  if (base && raised && !(raised.lum > base.lum + EPS)) issues.push({ control: 'raised vs base', detail: say(raised) + ' is not lighter than ' + say(base) + ' (a raised surface must be lighter than the base in both themes)' })
  if (base && overlay && !(overlay.lum > base.lum + EPS)) issues.push({ control: 'overlay vs base', detail: say(overlay) + ' is not lighter than ' + say(base) })
  if (raised && overlay && overlay.lum < raised.lum - EPS) issues.push({ control: 'overlay vs raised', detail: say(overlay) + ' is darker than ' + say(raised) + ' (an overlay must be at least as light as a raised surface)' })
  if (base && recessed) {
    if (dark ? !(recessed.lum < base.lum - EPS) : recessed.lum > base.lum + EPS) issues.push({ control: 'recessed vs base', detail: say(recessed) + (dark ? ' is not darker than ' : ' is lighter than ') + say(base) + ' (a recessed surface is ' + (dark ? 'darker than' : 'not lighter than') + ' the base in this theme)' })
  }
  if (raised && recessed && !(raised.lum > recessed.lum + EPS)) issues.push({ control: 'raised vs recessed', detail: say(raised) + ' is not lighter than ' + say(recessed) })
  // A large region (over 15% of the viewport) with no declared surface on it or around it.
  const missing: string[] = []
  const SEL = 'header,nav,aside,main,[role=region],[role=dialog],[role=banner],[role=navigation],[role=complementary],[role=main],[data-region]'
  for (const e of document.querySelectorAll(SEL)) {
    if (!shown(e) || e.closest('[data-surface]')) continue
    const r = e.getBoundingClientRect()
    if ((Math.min(r.right, vw) - Math.max(r.left, 0)) * (Math.min(r.bottom, vh) - Math.max(r.top, 0)) > 0.15 * vw * vh) missing.push(nameOf(e))
  }
  return { samples, issues, missing }
}

/** The page's declared surfaces, their order problems and the large regions that declare none ({} when the page cannot be measured). */
export async function surfaceCheck(page: Page): Promise<SurfaceResult> {
  try {
    return await page.evaluate(collectSurfaces)
  } catch {
    return { samples: [], issues: [], missing: [] }
  }
}
