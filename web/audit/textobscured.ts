// Text-obscured rule: visible text that is clipped by an overflow-hidden ancestor (no ellipsis, no title with the full text) or whose glyphs
// have another element on top of them. See README.md.
import type { Page } from '@playwright/test'

export type TextIssue = { kind: 'clipped' | 'covered'; el: string; by: string; text: string; detail: string }

/** Runs in the page (self-contained, it is serialised). */
function collectTextIssues(): TextIssue[] {
  const vw = innerWidth
  const vh = innerHeight
  // Parts of the page that draw or scroll their own text, and React Flow's own furniture: measured by their own rules or by design.
  const SKIP_TEXT = '.cm-editor,.ag-root-wrapper,.ag-root,svg,option,script,style,noscript,.react-flow__minimap,.react-flow__attribution,[aria-hidden=true],[inert]'
  // What may legitimately lie over text: popups and the canvas's own overlays.
  const OVERLAY_HIT = '.react-flow__handle,.react-flow__resize-control,.react-flow__panel,.react-flow__controls,.react-flow__minimap,.react-flow__selection,.react-flow__nodesselection,[role=menu],[role=listbox],[role=tooltip],[role=dialog],[role=alertdialog],.cm-tooltip,.ag-popup'
  const FLOW_CLIP = '.react-flow,.react-flow__renderer,.react-flow__pane,.react-flow__viewport,.react-flow__nodes,.react-flow__container'
  const cls = (e: Element) => (typeof (e as HTMLElement).className === 'string' ? (e as HTMLElement).className.trim().split(/\s+/).filter((c) => c && !/\d{3,}/.test(c)).slice(0, 2).join('.') : '')
  const describe = (e: Element) => e.tagName.toLowerCase() + (cls(e) ? '.' + cls(e) : '') + (e.getAttribute('data-testid') ? '[' + e.getAttribute('data-testid') + ']' : '') + (e.getAttribute('aria-label') ? ' "' + e.getAttribute('aria-label')!.slice(0, 30) + '"' : '')
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim()
  const modals = [...document.querySelectorAll('[aria-modal=true]')].filter((m) => (m as HTMLElement).offsetParent !== null || getComputedStyle(m).position === 'fixed')
  const topModal = modals.length ? modals[modals.length - 1] : null
  const out: TextIssue[] = []
  const seen = new Set<string>()
  const add = (i: TextIssue) => {
    const k = i.kind + '|' + i.el + '|' + i.by
    if (!seen.has(k)) {
      seen.add(k)
      out.push(i)
    }
  }
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  let n = 0
  for (let node = walker.nextNode(); node && n < 800; node = walker.nextNode()) {
    const text = norm(node.textContent ?? '')
    const el = node.parentElement
    if (!text || !el || el.closest(SKIP_TEXT)) continue
    if (topModal && !topModal.contains(el)) continue
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue
    n++
    const range = document.createRange()
    range.selectNodeContents(node)
    const rects = [...range.getClientRects()].filter((r) => r.width >= 2 && r.height >= 2 && r.right > 0 && r.bottom > 0 && r.left < vw && r.top < vh)
    if (!rects.length) continue
    // The clipping boxes: ancestors that cut their content off (hidden or clip, not scrollers), and everything that clips or scrolls, for what shows.
    const cutters: { e: Element; r: DOMRect; x: boolean; y: boolean }[] = []
    let shown = { l: 0, t: 0, r: vw, b: vh }
    // Text inside a scroller (auto or scroll) is not cut off at the edge of a box further out on that axis: it scrolls there.
    let scrollX = false
    let scrollY = false
    for (let p: Element | null = el; p && p !== document.documentElement; p = p.parentElement) {
      const s = getComputedStyle(p)
      const cutX = /hidden|clip/.test(s.overflowX) && !scrollX
      const cutY = /hidden|clip/.test(s.overflowY) && !scrollY
      if (/auto|scroll/.test(s.overflowX)) scrollX = true
      if (/auto|scroll/.test(s.overflowY)) scrollY = true
      const clipsAny = s.overflowX !== 'visible' || s.overflowY !== 'visible' || /paint|content|strict/.test(s.contain)
      if (!clipsAny) continue
      const pr = p.getBoundingClientRect()
      const box = { l: pr.left + p.clientLeft, t: pr.top + p.clientTop, r: pr.left + p.clientLeft + p.clientWidth, b: pr.top + p.clientTop + p.clientHeight }
      shown = { l: Math.max(shown.l, box.l), t: Math.max(shown.t, box.t), r: Math.min(shown.r, box.r), b: Math.min(shown.b, box.b) }
      if ((cutX || cutY) && !p.matches(FLOW_CLIP) && p.clientWidth > 2 && p.clientHeight > 2) cutters.push({ e: p, r: new DOMRect(box.l, box.t, box.r - box.l, box.b - box.t), x: cutX, y: cutY })
    }
    // (a) Clipped: a line of the text sticks out of an overflow-hidden ancestor, which shows part of it.
    for (const rect of rects) {
      for (const c of cutters) {
        const out1 = (c.x && (rect.right > c.r.right + 1.5 || rect.left < c.r.left - 1.5)) || (c.y && (rect.bottom > c.r.bottom + 1.5 || rect.top < c.r.top - 1.5))
        const showsSome = Math.min(rect.right, c.r.right) - Math.max(rect.left, c.r.left) > 1 && Math.min(rect.bottom, c.r.bottom) - Math.max(rect.top, c.r.top) > 1
        if (!out1 || !showsSome) continue
        // By design: an ellipsis on the text or the clipper, or a title or label that carries the full text.
        let excused = false
        for (let q: Element | null = el; q; q = q.parentElement) {
          const qs = getComputedStyle(q)
          if (qs.textOverflow === 'ellipsis' || qs.webkitLineClamp !== 'none' && qs.webkitLineClamp !== '') excused = true
          const t = norm((q.getAttribute('title') ?? '') + ' ' + (q.getAttribute('aria-label') ?? ''))
          if (t && (t.includes(text) || t.length >= text.length)) excused = true
          if (q === c.e) break
        }
        if (!excused) add({ kind: 'clipped', el: describe(el), by: describe(c.e), text: text.slice(0, 50), detail: 'text "' + text.slice(0, 50) + '" in ' + describe(el) + ' is cut off by the overflow-hidden ' + describe(c.e) + ' (no ellipsis, no title with the full text)' })
      }
    }
    // elementFromPoint cannot see an element with pointer-events: none (a hint laid over the canvas), so give the text's element hit-testing for the measurement.
    const had = el.style.getPropertyValue('pointer-events')
    const hadPrio = el.style.getPropertyPriority('pointer-events')
    const none = getComputedStyle(el).pointerEvents === 'none'
    if (none) el.style.setProperty('pointer-events', 'auto', 'important')
    // (b) Covered: the element at a point inside the shown part of the text is neither the text's element nor related to it.
    for (const rect of rects) {
      const l = Math.max(rect.left, shown.l)
      const r = Math.min(rect.right, shown.r)
      const t = Math.max(rect.top, shown.t)
      const b = Math.min(rect.bottom, shown.b)
      if (r - l < 2 || b - t < 2) continue
      const cy = (t + b) / 2
      for (const fx of [0.03, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.97]) {
        const x = l + (r - l) * fx
        const hit = document.elementFromPoint(x, cy)
        if (!hit || hit === el || el.contains(hit) || hit.contains(el)) continue
        if (hit.closest(OVERLAY_HIT) || hit.closest('.modal-backdrop') || (hit.closest('.react-flow__node') && hit.closest('.react-flow__node') !== el.closest('.react-flow__node'))) continue
        let sticky = false
        for (let q: Element | null = hit; q && q !== document.body; q = q.parentElement) if (/sticky|fixed/.test(getComputedStyle(q).position)) sticky = true
        if (sticky) continue
        if (typeof hit.checkVisibility === 'function' && !hit.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue
        add({ kind: 'covered', el: describe(el), by: describe(hit), text: text.slice(0, 50), detail: 'text "' + text.slice(0, 50) + '" in ' + describe(el) + ' has ' + describe(hit) + ' on top of it at (' + Math.round(x) + ',' + Math.round(cy) + ')' })
        break
      }
    }
    if (none) {
      if (had) el.style.setProperty('pointer-events', had, hadPrio)
      else el.style.removeProperty('pointer-events')
    }
  }
  return out
}

/** The obscured text on the page as it is now ([] when the page cannot be measured). */
export async function textIssues(page: Page): Promise<TextIssue[]> {
  try {
    return await page.evaluate(collectTextIssues)
  } catch {
    return []
  }
}
