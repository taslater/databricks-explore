import { useLayoutEffect, useRef, useState, type RefObject } from 'react'

/**
 * How many of a toolbar's lower-priority items have to move into its menu so the toolbar stays on its rows. Starts at 0
 * (everything in view) and goes up one step at a time, before the browser paints, while `wraps(el)` says the toolbar has
 * wrapped (and again whenever it resizes), up to `max`. Measures the real layout, so it adapts to any font, zoom or window width; it starts over from 0
 * when the toolbar's width changes or the fonts finish loading.
 */
export function useOverflowLevel(ref: RefObject<HTMLElement | null>, max: number, wraps: (el: HTMLElement) => boolean): number {
  const [level, setLevel] = useState(0)
  const [, setTick] = useState(0)
  const wrapsRef = useRef(wraps)
  wrapsRef.current = wraps
  // After every render: a toolbar that still wraps gives up one more item (bounded by max, so this settles).
  useLayoutEffect(() => {
    const el = ref.current
    if (el && level < max && wrapsRef.current(el)) setLevel(level + 1)
  })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    let width = el.clientWidth
    const restart = () => {
      setLevel(0)
      setTick((n) => n + 1) // look again even when the level was already 0
    }
    const observer = new ResizeObserver(() => {
      if (el.clientWidth !== width) {
        width = el.clientWidth
        restart()
      } else {
        // The height changed with the width unchanged (a font loaded, a label grew): look again, which may step the level up.
        setTick((n) => n + 1)
      }
    })
    observer.observe(el)
    void document.fonts?.ready.then(restart)
    return () => observer.disconnect()
  }, [ref])
  return level
}

/** True when a flex-wrap container has an item that starts below the end of its first item: it has more than one row. */
export function hasWrapped(el: HTMLElement): boolean {
  const items = Array.from(el.children).filter((c) => getComputedStyle(c).position !== 'absolute')
  if (items.length < 2) return false
  const first = items[0].getBoundingClientRect()
  return items.some((c) => c.getBoundingClientRect().top >= first.bottom - 1)
}
