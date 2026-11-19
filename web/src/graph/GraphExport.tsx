// The Graph's Export: a picture with its title, legend and date (download or copy), and Mermaid text for a pull request,
// wiki or README. Local only: the picture is drawn in the page and the Mermaid comes from the app's own server.
import { useEffect, useMemo, useRef, useState } from 'react'
import * as api from '../api/client'
import { useNodeFacts } from '../api/nodeFacts'
import { messageOf } from './actions'
import { useNodeColors } from './ColorByControl'
import { deriveFlow } from './derive'
import { useCardinality } from './EdgeEnds'
import { useEdgeTransforms } from './EdgeTransforms'
import {
  canvasBlob,
  dateLine,
  factsReadDate,
  fileStem,
  pictureLegend,
  renderPicture,
  type PictureScope,
} from './exportPicture'
import { useGraphStore } from './graphStore'

/** {edge id: glyph names} for the flow edges whose transform is known, as the Mermaid route labels them. */
function glyphsOf(edges: Array<{ id: string }>, transforms: Record<string, { transform: { glyphs: string[] } | null }> | undefined): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const e of edges) {
    const g = transforms?.[e.id]?.transform?.glyphs
    if (g && g.length > 0) out[e.id] = g
  }
  return out
}

/** The toolbar's Export button and its dialog. */
export function GraphExportButton() {
  const [open, setOpen] = useState(false)
  const hasNodes = useGraphStore((s) => s.nodes.length > 0)
  return (
    <>
      <button style={{ whiteSpace: 'nowrap', flexShrink: 0 }} onClick={() => setOpen(true)} disabled={!hasNodes} title="Export a picture with its legend, or Mermaid text">
        Export…
      </button>
      {open && <ExportDialog onClose={() => setOpen(false)} />}
    </>
  )
}

function ExportDialog({ onClose }: { onClose: () => void }) {
  const nodes = useGraphStore((s) => s.nodes)
  const edges = useGraphStore((s) => s.edges)
  const columnEdges = useGraphStore((s) => s.columnEdges)
  const focusSchema = useGraphStore((s) => s.focusSchema)
  const filters = useGraphStore((s) => s.filters)
  const openName = useGraphStore((s) => s.openDiagram?.name)
  const [title, setTitle] = useState(openName ?? 'Graph')
  const [caption, setCaption] = useState('')
  const [scope, setScope] = useState<PictureScope>('graph')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null)
  const [mermaid, setMermaid] = useState('')
  const firstField = useRef<HTMLInputElement>(null)
  useEffect(() => firstField.current?.focus(), [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const { colorBy, colors } = useNodeColors()
  const ends = useCardinality().data
  const transforms = useEdgeTransforms().data?.edges
  const flow = useMemo(() => deriveFlow({ nodes, edges, columnEdges, focusSchema, filters, hoverId: null }), [nodes, edges, columnEdges, focusSchema, filters])
  const shownNodes = flow.nodes.filter((n) => !n.hidden)
  const shownEdges = flow.edges.filter((e) => !e.hidden).map((e) => e.data!.info)
  const facts = useNodeFacts(shownNodes.filter((n) => !n.data.missing && !n.id.startsWith('ph:')).map((n) => n.id)).data
  const legend = useMemo(
    () => pictureLegend({ edges: shownEdges, filters, ends, nodes: shownNodes, colorBy, colors }),
    [flow, filters, ends, colorBy, colors],
  )
  const read = factsReadDate(shownEdges, facts)
  const today = new Date().toISOString().slice(0, 10)

  async function picture(): Promise<Blob> {
    const root = document.querySelector<HTMLElement>('.graph-canvas')
    if (!root) throw new Error('The graph is not showing.')
    const canvas = await renderPicture(root, scope, { title: title.trim() || 'Graph', caption, legend, date: dateLine(read, today) })
    return canvasBlob(canvas)
  }

  async function run(what: () => Promise<string>) {
    setBusy(true)
    setNote(null)
    try {
      setNote({ text: await what(), error: false })
    } catch (e) {
      setNote({ text: messageOf(e), error: true })
    } finally {
      setBusy(false)
    }
  }

  const download = () =>
    run(async () => {
      const url = URL.createObjectURL(await picture())
      const a = document.createElement('a')
      a.href = url
      a.download = `${fileStem(title)}.png`
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
      return `Saved ${a.download}.`
    })

  const copyImage = () =>
    run(async () => {
      if (!navigator.clipboard || typeof ClipboardItem === 'undefined') throw new Error('This browser cannot copy images. Download the PNG instead.')
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': picture() })])
      return 'Copied the image.'
    })

  const copyMermaid = (lens: 'flow' | 'model') =>
    run(async () => {
      const text = await api.getMermaid({ lens, nodes: shownNodes.map((n) => ({ id: n.id, kind: n.data.kind })), edges: shownEdges, glyphs: glyphsOf(shownEdges, transforms) })
      setMermaid(text)
      try {
        await navigator.clipboard.writeText(text)
        return `Copied ${lens === 'flow' ? 'the flowchart' : 'the ER diagram'}. Paste it in a \`\`\`mermaid fence.`
      } catch {
        return 'Select the text below and copy it.'
      }
    })

  return (
    <div className="modal-backdrop app-dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <div className="modal app-dialog graph-export" role="dialog" aria-modal="true" aria-label="Export the graph" onMouseDown={(e) => e.stopPropagation()}>
        <h3>Export the graph</h3>
        <label className="app-dialog-field">
          Title
          <input ref={firstField} value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className="app-dialog-field">
          Caption (optional)
          <input value={caption} onChange={(e) => setCaption(e.target.value)} placeholder="One line under the title" />
        </label>
        <label className="app-dialog-field">
          Picture of
          <select value={scope} onChange={(e) => setScope(e.target.value as PictureScope)}>
            <option value="graph">the whole graph</option>
            <option value="view">the current view</option>
          </select>
        </label>
        <p className="hint graph-export-legend" aria-label="Legend of the picture">
          {legend.length > 0 ? `Legend: ${legend.map((l) => l.text).join('; ')}.` : 'No legend: nothing on the graph needs one.'} {dateLine(read, today)}.
        </p>
        <div className="app-dialog-actions graph-export-actions">
          <button disabled={busy} onClick={() => void download()}>
            Download PNG
          </button>
          <button disabled={busy} onClick={() => void copyImage()}>
            Copy image
          </button>
          <button disabled={busy} onClick={() => void copyMermaid('flow')} title="data flows left to right; GitHub renders it">
            Copy Mermaid flowchart
          </button>
          <button disabled={busy} onClick={() => void copyMermaid('model')} title="key references as an erDiagram, with crow's-foot ends and key columns">
            Copy Mermaid ER
          </button>
        </div>
        {note && (
          <p className={note.error ? 'error' : 'hint'} role={note.error ? 'alert' : 'status'}>
            {note.text}
          </p>
        )}
        {mermaid && <textarea className="graph-export-text" readOnly rows={8} value={mermaid} aria-label="Mermaid text" onFocus={(e) => e.currentTarget.select()} />}
        <div className="app-dialog-actions">
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}
