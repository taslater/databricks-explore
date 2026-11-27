// Export the canvas, or the selection, as PNG or SVG with html-to-image (MIT, about 24 KB unminified).
// The SVG wraps the rendered HTML in a foreignObject, so it opens correctly in browsers and most viewers, but
// editors that ignore foreignObject (some vector editors) show it empty. PNG renders everywhere.
import { getNodesBounds, type Edge, type Node as FlowNode } from '@xyflow/react'
import { toPng, toSvg } from 'html-to-image'
import { inLightTheme, lightTokens } from '../theme'

export type ExportFormat = 'png' | 'svg'

const PADDING = 32
/** Longest side, in CSS pixels, before the output is scaled down. Keeps a huge canvas from failing to render. */
const MAX_SIDE = 8000

export interface ExportRequest {
  format: ExportFormat
  /** Export only the selected nodes (and the connectors between them). */
  selectionOnly: boolean
  nodes: FlowNode[]
  edges: Edge[]
  /** Element that contains `.react-flow__viewport`. */
  root: HTMLElement
}

/** The nodes that go into the picture, and the edge ids that may be drawn with them. */
export function exportScope(nodes: FlowNode[], edges: Edge[], selectionOnly: boolean): { nodes: FlowNode[]; edgeIds: Set<string> } {
  const picked = selectionOnly ? nodes.filter((n) => n.selected) : nodes
  const ids = new Set(picked.map((n) => n.id))
  const edgeIds = new Set(edges.filter((e) => ids.has(e.source) && ids.has(e.target)).map((e) => e.id))
  return { nodes: picked, edgeIds }
}

/** Size of the picture and the translation that puts the top-left of the content at the padding. */
export function exportFrame(bounds: { x: number; y: number; width: number; height: number }) {
  const width = Math.ceil(bounds.width + PADDING * 2)
  const height = Math.ceil(bounds.height + PADDING * 2)
  const scale = Math.min(1, MAX_SIDE / Math.max(width, height))
  return { width, height, tx: PADDING - bounds.x, ty: PADDING - bounds.y, scale }
}

/** Saves a data URL as a file. Goes through a Blob, which browsers handle better than a long data URL. */
async function download(dataUrl: string, filename: string) {
  const blob = await (await fetch(dataUrl)).blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/** Renders and downloads the picture. Throws an Error with a message for the user when there is nothing to draw. */
export async function exportDiagram(req: ExportRequest, filename: string): Promise<void> {
  const { nodes, edgeIds } = exportScope(req.nodes, req.edges, req.selectionOnly)
  if (nodes.length === 0) throw new Error(req.selectionOnly ? 'Nothing is selected.' : 'The canvas is empty.')
  const viewport = req.root.querySelector<HTMLElement>('.react-flow__viewport')
  if (!viewport) throw new Error('The canvas is not showing.')

  const frame = exportFrame(getNodesBounds(nodes))
  const keepNodes = new Set(nodes.map((n) => n.id))
  const filter = (el: Node): boolean => {
    const e = el as Element
    if (!(e instanceof Element)) return true
    if (e.classList.contains('sketch-export-hide')) return false
    if (e.classList.contains('react-flow__node')) return keepNodes.has(e.getAttribute('data-id') ?? '')
    if (e.classList.contains('react-flow__edge')) return edgeIds.has((e.getAttribute('data-testid') ?? '').replace(/^rf__edge-/, ''))
    const label = e.getAttribute('data-edge-id')
    if (label !== null) return edgeIds.has(label)
    return true
  }

  req.root.setAttribute('data-exporting', '1')
  try {
    const options = {
      backgroundColor: lightTokens(['surface']).surface,
      width: Math.round(frame.width * frame.scale),
      height: Math.round(frame.height * frame.scale),
      pixelRatio: req.format === 'png' ? 2 : 1,
      filter,
      style: {
        width: `${frame.width}px`,
        height: `${frame.height}px`,
        transform: `scale(${frame.scale}) translate(${frame.tx}px, ${frame.ty}px)`,
        transformOrigin: '0 0',
      },
    }
    // A picture is always light, whatever the page shows: the viewport is drawn in the light theme for the length of the capture.
    const href = await inLightTheme(viewport, () => (req.format === 'png' ? toPng(viewport, options) : toSvg(viewport, options)))
    await download(href, filename)
  } finally {
    req.root.removeAttribute('data-exporting')
  }
}
