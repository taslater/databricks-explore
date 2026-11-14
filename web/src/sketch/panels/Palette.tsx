import { useSketchStore } from '../sketchStore'
import { SHAPE_NAMES } from '../model'
import { keyForTool } from '../useSketchKeys'
import type { Tool } from '../types'
import { ToolIcon } from './icons'

const GROUPS: { tool: Tool; name: string }[][] = [
  [
    { tool: 'select', name: 'Select (marquee on drag; Shift or Cmd/Ctrl-click adds)' },
    { tool: 'hand', name: 'Pan (or hold Space)' },
    { tool: 'connect', name: 'Connect: drag from a side of one node to another' },
  ],
  [
    { tool: 'rect', name: SHAPE_NAMES.rect },
    { tool: 'rounded', name: SHAPE_NAMES.rounded },
    { tool: 'ellipse', name: SHAPE_NAMES.ellipse },
    { tool: 'diamond', name: SHAPE_NAMES.diamond },
    { tool: 'cylinder', name: SHAPE_NAMES.cylinder },
  ],
  [
    { tool: 'text', name: 'Text' },
    { tool: 'sticky', name: 'Sticky note' },
    { tool: 'frame', name: 'Frame (moves what is inside it)' },
    { tool: 'placeholder', name: 'Table that does not exist yet' },
  ],
]

/** The left tool palette. Click a tool, then click the canvas (default size) or drag (your size). */
export function Palette() {
  const tool = useSketchStore((s) => s.tool)
  const setTool = useSketchStore((s) => s.setTool)
  return (
    <div className="sk-palette" role="toolbar" aria-label="Sketch tools" aria-orientation="vertical">
      {GROUPS.map((group, gi) => (
        <div key={gi} className="sk-palette-group">
          {group.map(({ tool: t, name }) => (
            <button
              key={t}
              className={tool === t ? 'active' : undefined}
              aria-pressed={tool === t}
              aria-label={name}
              data-tool={t}
              title={`${name} (${keyForTool(t)})`}
              onClick={() => setTool(tool === t && t !== 'select' ? 'select' : t)}
            >
              <ToolIcon tool={t} />
            </button>
          ))}
        </div>
      ))}
    </div>
  )
}
