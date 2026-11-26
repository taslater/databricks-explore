// Theme: system, light or dark. The choice is remembered in localStorage; index.html applies it before the first paint and this module keeps it in step.
import { useSyncExternalStore } from 'react'

export type ThemePref = 'system' | 'light' | 'dark'
export type Theme = 'light' | 'dark'
export const THEME_KEY = 'explore.theme'

const listeners = new Set<() => void>()
const query = () => (typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null)

/** The stored choice; system when none (or storage is unavailable). */
export function readThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(THEME_KEY)
    return v === 'light' || v === 'dark' ? v : 'system'
  } catch {
    return 'system'
  }
}

/** What a choice looks like right now: system follows the browser. */
export const resolveTheme = (pref: ThemePref): Theme => (pref === 'system' ? (query()?.matches ? 'dark' : 'light') : pref)

/** Puts the resolved theme on the root element, where the stylesheet reads it. */
export function applyTheme(): Theme {
  const theme = resolveTheme(readThemePref())
  document.documentElement.dataset.theme = theme
  return theme
}

/** Remembers a choice and applies it. */
export function setThemePref(pref: ThemePref) {
  try {
    if (pref === 'system') localStorage.removeItem(THEME_KEY)
    else localStorage.setItem(THEME_KEY, pref)
  } catch {
    /* storage blocked: the choice lasts until reload */
  }
  applyTheme()
  listeners.forEach((l) => l())
}

/** Runs fn with el drawn in the light theme (a data-theme='light' scope inside a dark page), then puts it back. */
export async function inLightTheme<T>(el: HTMLElement, fn: () => Promise<T>): Promise<T> {
  const had = el.getAttribute('data-theme')
  el.setAttribute('data-theme', 'light')
  try {
    return await fn()
  } finally {
    if (had === null) el.removeAttribute('data-theme')
    else el.setAttribute('data-theme', had)
  }
}

/** The light values of some tokens (names without the leading --), for drawing a picture that is always light: read from a light-scoped element. */
export function lightTokens<K extends string>(names: readonly K[]): Record<K, string> {
  const probe = document.createElement('div')
  probe.setAttribute('data-theme', 'light')
  probe.style.display = 'none'
  document.body.appendChild(probe)
  const style = getComputedStyle(probe)
  const out = Object.fromEntries(names.map((n) => [n, style.getPropertyValue('--' + n).trim()])) as Record<K, string>
  probe.remove()
  return out
}

/** A colour as a concrete value in the light theme (a token reference such as var(--fill-table) becomes rgb(...)), for canvas drawing, which cannot read CSS variables. */
export function lightColor(color: string): string {
  const probe = document.createElement('div')
  probe.setAttribute('data-theme', 'light')
  probe.style.display = 'none'
  probe.style.color = color
  document.body.appendChild(probe)
  const out = getComputedStyle(probe).color
  probe.remove()
  return out
}

let started = false
/** Follows the system setting and other tabs while the choice is system. Call once at startup. */
export function initTheme() {
  applyTheme()
  if (started) return
  started = true
  const notify = () => {
    applyTheme()
    listeners.forEach((l) => l())
  }
  query()?.addEventListener('change', notify)
  window.addEventListener('storage', (e) => e.key === THEME_KEY && notify())
}

const subscribe = (cb: () => void) => (listeners.add(cb), () => void listeners.delete(cb))
const snapshot = () => readThemePref() + '|' + resolveTheme(readThemePref())

/** The choice and the theme in force, re-rendering on change. */
export function useTheme(): { pref: ThemePref; theme: Theme } {
  const [pref, theme] = useSyncExternalStore(subscribe, snapshot).split('|')
  return { pref: pref as ThemePref, theme: theme as Theme }
}
