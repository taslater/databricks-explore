import { setThemePref, useTheme, type ThemePref } from '../theme'

const ORDER: ThemePref[] = ['system', 'light', 'dark']
const NAME: Record<ThemePref, string> = { system: 'system', light: 'light', dark: 'dark' }
const ICON: Record<ThemePref, string> = {
  system: 'M2 3h12v8H2zM6 14h4M8 11v3',
  light: 'M8 5a3 3 0 100 6 3 3 0 000-6zM8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.4 1.4M11.6 11.6L13 13M3 13l1.4-1.4M11.6 4.4L13 3',
  dark: 'M13 9.5A5.5 5.5 0 116.5 3 4.5 4.5 0 0013 9.5z',
}

/** Header control: a quiet icon button that cycles system, light and dark. The choice is remembered in localStorage and shown in the label. */
export function ThemeToggle() {
  const { pref } = useTheme()
  const next = ORDER[(ORDER.indexOf(pref) + 1) % ORDER.length]
  const label = `Theme: ${NAME[pref]}`
  return (
    <button className="ghost theme-toggle" data-theme-pref={pref} aria-label={label} title={`${label}. Click for ${NAME[next]}`} onClick={() => setThemePref(next)}>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d={ICON[pref]} />
      </svg>
    </button>
  )
}
