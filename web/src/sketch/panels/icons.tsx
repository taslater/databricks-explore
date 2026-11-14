import type { ReactNode } from 'react'
import type { Tool } from '../types'

const common = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' } as const

const ICONS: Record<Tool, ReactNode> = {
  select: <path d="M5 3 L5 16 L8.3 12.8 L10.6 17.5 L12.6 16.6 L10.3 12 L14.8 12 Z" {...common} />,
  hand: (
    <>
      <path d="M10 2.5 V17.5 M2.5 10 H17.5" {...common} />
      <path d="M8 4.5 L10 2.5 L12 4.5 M8 15.5 L10 17.5 L12 15.5 M4.5 8 L2.5 10 L4.5 12 M15.5 8 L17.5 10 L15.5 12" {...common} />
    </>
  ),
  connect: (
    <>
      <path d="M3 16 L16 4" {...common} />
      <path d="M10.5 4 L16 4 L16 9.5" {...common} />
    </>
  ),
  rect: <rect x="3" y="5" width="14" height="10" {...common} />,
  rounded: <rect x="3" y="5" width="14" height="10" rx="4" {...common} />,
  ellipse: <ellipse cx="10" cy="10" rx="7.5" ry="5.5" {...common} />,
  diamond: <path d="M10 3 L17 10 L10 17 L3 10 Z" {...common} />,
  cylinder: (
    <>
      <path d="M4 5.5 V14.5 A6 2.5 0 0 0 16 14.5 V5.5" {...common} />
      <ellipse cx="10" cy="5.5" rx="6" ry="2.5" {...common} />
    </>
  ),
  text: <path d="M4.5 4.5 H15.5 M10 4.5 V16 M8 16 H12" {...common} />,
  sticky: (
    <>
      <path d="M3.5 3.5 H16.5 V12 L12 16.5 H3.5 Z" {...common} />
      <path d="M12 16.5 V12 H16.5" {...common} />
    </>
  ),
  frame: (
    <>
      <rect x="3" y="4" width="14" height="12" strokeDasharray="2.5 2" {...common} />
      <path d="M3 7.5 H9" {...common} />
    </>
  ),
  placeholder: (
    <>
      <rect x="3" y="3.5" width="14" height="13" strokeDasharray="2.5 2" {...common} />
      <path d="M3 7.5 H17 M3 11.5 H17 M8 7.5 V16.5" {...common} />
    </>
  ),
}

/** A 20 px line icon for a palette tool. */
export function ToolIcon({ tool }: { tool: Tool }) {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
      {ICONS[tool]}
    </svg>
  )
}

const ARRANGE: Record<string, ReactNode> = {
  left: <path d="M3 3 V17 M6 6 H16 M6 11 H12" {...common} />,
  center: <path d="M10 3 V17 M4 6 H16 M6 11 H14" {...common} />,
  right: <path d="M17 3 V17 M4 6 H14 M8 11 H14" {...common} />,
  top: <path d="M3 3 H17 M6 6 V16 M11 6 V12" {...common} />,
  middle: <path d="M3 10 H17 M6 4 V16 M11 6 V14" {...common} />,
  bottom: <path d="M3 17 H17 M6 4 V14 M11 8 V14" {...common} />,
  'distribute-h': <path d="M3 3 V17 M17 3 V17 M8 6 H12 V14 H8 Z" {...common} />,
  'distribute-v': <path d="M3 3 H17 M3 17 H17 M6 8 V12 H14 V8 Z" {...common} />,
  front: <path d="M7 7 H16 V16 H7 Z M4 4 H13 V7" {...common} />,
  forward: <path d="M5 10 L10 5 L15 10 M10 5 V16" {...common} />,
  backward: <path d="M5 10 L10 15 L15 10 M10 15 V4" {...common} />,
  back: <path d="M4 4 H13 V13 H4 Z M13 7 H16 V16 H7 V13" {...common} />,
  undo: <path d="M7 6 L3.5 9.5 L7 13 M3.5 9.5 H12.5 A4 4 0 0 1 12.5 17.5 H9" {...common} />,
  redo: <path d="M13 6 L16.5 9.5 L13 13 M16.5 9.5 H7.5 A4 4 0 0 0 7.5 17.5 H11" {...common} />,
  lock: (
    <>
      <rect x="4.5" y="9" width="11" height="8" rx="1.5" {...common} />
      <path d="M7 9 V6.5 A3 3 0 0 1 13 6.5 V9" {...common} />
    </>
  ),
}

export function ArrangeIcon({ name }: { name: keyof typeof ARRANGE | string }) {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">
      {ARRANGE[name]}
    </svg>
  )
}
