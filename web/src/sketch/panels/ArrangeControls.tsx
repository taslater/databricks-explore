import { useSketchStore } from '../sketchStore'
import type { AlignMode, DistributeAxis, OrderOp } from '../model'
import { ArrangeIcon } from './icons'

const ALIGN: { mode: AlignMode; name: string }[] = [
  { mode: 'left', name: 'Align left edges' },
  { mode: 'center', name: 'Align centers horizontally' },
  { mode: 'right', name: 'Align right edges' },
  { mode: 'top', name: 'Align top edges' },
  { mode: 'middle', name: 'Align centers vertically' },
  { mode: 'bottom', name: 'Align bottom edges' },
]

const DISTRIBUTE: { axis: DistributeAxis; icon: string; name: string }[] = [
  { axis: 'horizontal', icon: 'distribute-h', name: 'Distribute horizontally (equal gaps, 3 or more)' },
  { axis: 'vertical', icon: 'distribute-v', name: 'Distribute vertically (equal gaps, 3 or more)' },
]

const ORDER: { op: OrderOp; name: string; keys: string }[] = [
  { op: 'front', name: 'Bring to front', keys: 'Shift+Cmd/Ctrl+]' },
  { op: 'forward', name: 'Bring forward', keys: 'Cmd/Ctrl+]' },
  { op: 'backward', name: 'Send backward', keys: 'Cmd/Ctrl+[' },
  { op: 'back', name: 'Send to back', keys: 'Shift+Cmd/Ctrl+[' },
]

/** Align, distribute, stacking order and lock for the current selection. Used in the Arrange menu and the properties panel. */
export function ArrangeControls() {
  const selected = useSketchStore((s) => s.selectedIds.length)
  const align = useSketchStore((s) => s.align)
  const distribute = useSketchStore((s) => s.distribute)
  const reorder = useSketchStore((s) => s.reorder)
  const toggleLock = useSketchStore((s) => s.toggleLock)
  return (
    <div className="sk-arrange">
      <div className="sk-arrange-row" role="group" aria-label="Align">
        {ALIGN.map((a) => (
          <button key={a.mode} disabled={selected < 2} title={a.name} aria-label={a.name} onClick={() => align(a.mode)}>
            <ArrangeIcon name={a.mode} />
          </button>
        ))}
        {DISTRIBUTE.map((d) => (
          <button key={d.axis} disabled={selected < 3} title={d.name} aria-label={d.name} onClick={() => distribute(d.axis)}>
            <ArrangeIcon name={d.icon} />
          </button>
        ))}
      </div>
      <div className="sk-arrange-row" role="group" aria-label="Order">
        {ORDER.map((o) => (
          <button key={o.op} disabled={selected < 1} title={`${o.name} (${o.keys})`} aria-label={o.name} onClick={() => reorder(o.op)}>
            <ArrangeIcon name={o.op} />
          </button>
        ))}
        <button disabled={selected < 1} title="Lock or unlock (Shift+Cmd/Ctrl+L)" aria-label="Lock or unlock" onClick={toggleLock}>
          <ArrangeIcon name="lock" />
        </button>
      </div>
    </div>
  )
}
