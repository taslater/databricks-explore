import type { HostNode, SketchNode } from '../types'
import type { Swatch } from '../model'

/** A row of color swatches. `none` draws as a crossed-out box. */
export function Swatches({ swatches, value, onPick }: { swatches: Swatch[]; value: string | undefined; onPick: (v: string) => void }) {
  return (
    <div className="sk-swatches" role="group">
      {swatches.map((s) => (
        <button
          key={s.value}
          className={`sk-swatch${value === s.value ? ' active' : ''}${s.value === 'none' ? ' none' : ''}`}
          style={s.value === 'none' ? undefined : { background: s.value }}
          title={s.name}
          aria-label={s.name}
          aria-pressed={value === s.value}
          onClick={() => onPick(s.value)}
        />
      ))}
    </div>
  )
}

/** A short name for a node: its label or table name, else what kind of node it is. */
export function nodeName(node: SketchNode | undefined, host: HostNode | undefined): string {
  if (node) {
    if (node.type === 'placeholder') return node.placeholder?.name || 'new table'
    const l = (node.label ?? '').trim().split('\n')[0]
    return l || node.type
  }
  if (host) return host.table?.split('.').pop() || host.title || host.type
  return '(missing)'
}
