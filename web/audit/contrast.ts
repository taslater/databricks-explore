// Text contrast rule: WCAG contrast between each visible text element's colour and its effective background. See README.md.
import type { Page } from '@playwright/test'

export type ContrastIssue = { sel: string; text: string; fg: string; bg: string; ratio: number; need: number; control: boolean; large: boolean }

/** Runs in the page (self-contained, it is serialised): one issue per element whose text is below the WCAG threshold. */
function collectContrast(): ContrastIssue[] {
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
  const lum = ([r, g, b]: C) => {
    const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
  }
  const hex = (c: C) => '#' + [c[0], c[1], c[2]].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')
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
  /** The opaque colour behind e's text, or null when a background-image is involved (unknown). */
  const backdrop = (e: Element): C | null => {
    const layers: C[] = []
    let alpha = 0
    for (let n: Element | null = e; n; n = n.parentElement) {
      const cs = getComputedStyle(n)
      if (cs.backgroundImage !== 'none') return null
      const c = parse(cs.backgroundColor)
      if (!c) return null
      if (c[3] > 0) {
        layers.push(c)
        alpha = alpha + c[3] * (1 - alpha)
        if (c[3] >= 1) break
      }
    }
    let acc: C = [255, 255, 255, 1] // the canvas
    for (let i = layers.length - 1; i >= 0; i--) acc = over(layers[i], acc)
    return acc
  }
  const vw = innerWidth
  const vh = innerHeight
  const CTRL = 'button,a[href],input,select,textarea,[role=button],[role=tab],[role=menuitem],[role=option],summary'
  const seen = new Set<string>()
  const out: ContrastIssue[] = []
  for (const e of [...document.body.getElementsByTagName('*')].slice(0, 6000)) {
    if (e.closest('svg') || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|BR|HEAD|META|LINK)$/.test(e.tagName)) continue
    const field = /^(INPUT|TEXTAREA|SELECT)$/.test(e.tagName) && !['checkbox', 'radio', 'range', 'hidden', 'color', 'file'].includes((e as HTMLInputElement).type)
    const own = [...e.childNodes].filter((n) => n.nodeType === 3).map((n) => (n.textContent ?? '').trim()).join(' ').trim()
    const text = own || (field && ((e as HTMLInputElement).value || (e as HTMLSelectElement).selectedOptions?.[0]?.text) ? String((e as HTMLInputElement).value || (e as HTMLSelectElement).selectedOptions?.[0]?.text) : '')
    if (!text) continue
    const cs = getComputedStyle(e)
    if (cs.display === 'none' || cs.visibility !== 'visible' || cs.opacity === '0') continue
    const r = e.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0 || r.right <= 0 || r.bottom <= 0 || r.left >= vw || r.top >= vh) continue
    if (e.closest(':disabled,[aria-disabled=true],[inert],[aria-hidden=true]')) continue // WCAG exempts disabled controls
    const bg = backdrop(e)
    const fgRaw = parse(cs.color)
    if (!bg || !fgRaw) continue
    const fg = over(fgRaw, bg)
    const l1 = lum(fg)
    const l2 = lum(bg)
    const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
    const px = parseFloat(cs.fontSize)
    const large = px >= 24 || (px >= 18.66 && Number(cs.fontWeight) >= 700)
    const need = large ? 3 : 4.5
    if (ratio >= need) continue
    const p = e.parentElement
    const sel = (p && p !== document.body ? one(p) + ' > ' : '') + one(e)
    const k = sel + hex(fg) + hex(bg)
    if (seen.has(k)) continue
    seen.add(k)
    out.push({ sel, text: text.replace(/\s+/g, ' ').slice(0, 24), fg: hex(fg), bg: hex(bg), ratio: Math.round(ratio * 100) / 100, need, control: !!e.closest(CTRL), large })
  }
  return out
}

/** Contrast issues of the page as it is now ([] when the page cannot be measured). */
export async function contrastIssues(page: Page): Promise<ContrastIssue[]> {
  try {
    return await page.evaluate(collectContrast)
  } catch {
    return []
  }
}
