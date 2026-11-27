import { setThemePref, useTheme, type ThemePref } from '../theme'

const CHOICES: { id: ThemePref; label: string; icon: string }[] = [
  { id: 'system', label: 'System theme', icon: 'M2 3h12v8H2zM6 14h4M8 11v3' },
  { id: 'light', label: 'Light theme', icon: 'M8 5a3 3 0 100 6 3 3 0 000-6zM8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.4 1.4M11.6 11.6L13 13M3 13l1.4-1.4M11.6 4.4L13 3' },
  { id: 'dark', label: 'Dark theme', icon: 'M13 9.5A5.5 5.5 0 116.5 3 4.5 4.5 0 0013 9.5z' },
]

/** Header control: follow the system, or force light or dark. The choice is remembered in localStorage. */
export function ThemeToggle() {
  const { pref } = useTheme()
  return (
    <div className="segmented theme-toggle" role="group" aria-label="Theme">
      {CHOICES.map((c) => (
        <button key={c.id} className={pref === c.id ? 'active' : undefined} aria-pressed={pref === c.id} aria-label={c.label} title={c.label} onClick={() => setThemePref(c.id)}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d={c.icon} />
          </svg>
        </button>
      ))}
    </div>
  )
}
