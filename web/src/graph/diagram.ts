// Saved diagram format. It matches what static/app.js wrote, so files load in both UIs:
//   {name, saved_at, focus_schema, nodes: [{data, position}], edges: [{data}]}
// Positions are node centers (Cytoscape convention). React Flow uses top-left, so we convert on save and load.
import type { DiagramBody, DiagramFile, FileUpstream, GraphEdge, SelfRefFk } from '../api/types'
import { parseColorBy, type ColorBy } from './colorBy'
import { nameOf, schemaOf } from './format'
import { estimateSize } from './layout'
import { nodeCenter, nodeSize, viaMap } from './derive'
import type { FlowEdge, FlowNode } from './types'

export interface SavedNodeData {
  id: string
  label?: string
  kind?: string
  focus?: boolean
  pinned?: boolean
  self_ref?: boolean
  self_ref_last_seen?: string
  self_ref_fks?: SelfRefFk[]
  files?: FileUpstream[]
  external?: boolean
  via?: string
}

interface SavedNode {
  data: SavedNodeData
  position: { x: number; y: number }
}

export interface DiagramPayload {
  nodes: FlowNode[]
  edges: FlowEdge[]
  focusSchema: string | null
  /** What the fill means; the default (type) is not written. */
  colorBy?: ColorBy
}

export function toDiagramBody(name: string, payload: DiagramPayload): DiagramBody {
  const via = viaMap(payload.edges)
  const nodes: SavedNode[] = payload.nodes.map((n) => {
    const size = nodeSize(n, payload.focusSchema, via.get(n.id))
    const c = nodeCenter(n, size)
    const data: SavedNodeData = {
      id: n.id,
      label: n.data.name,
      kind: n.data.kind,
      external: n.data.schema !== payload.focusSchema,
    }
    if (n.data.focus) data.focus = true
    if (n.data.pinned) data.pinned = true
    if (n.data.selfRef) data.self_ref = true
    if (n.data.selfRefLastSeen) data.self_ref_last_seen = n.data.selfRefLastSeen
    if (n.data.selfRefFks?.length) data.self_ref_fks = n.data.selfRefFks
    if (n.data.files?.length) data.files = n.data.files
    const v = via.get(n.id)
    if (v) data.via = v
    return { data, position: { x: c.x, y: c.y } }
  })
  const edges = payload.edges.map((e) => ({ data: e.data!.info }))
  return { name, focus_schema: payload.focusSchema, nodes, edges, ...(payload.colorBy && payload.colorBy !== 'type' ? { color_by: payload.colorBy } : {}) }
}

/** Reads a saved diagram (either UI's format). Malformed entries are skipped, not thrown. */
export function fromDiagram(d: DiagramFile): DiagramPayload {
  const savedNodes = Array.isArray(d.nodes) ? (d.nodes as SavedNode[]) : []
  const savedEdges = Array.isArray(d.edges) ? (d.edges as Array<{ data: GraphEdge }>) : []
  const focusSchema = typeof d.focus_schema === 'string' ? d.focus_schema : null

  const nodes: FlowNode[] = []
  const ids = new Set<string>()
  for (const n of savedNodes) {
    const data = n?.data
    if (!data?.id || ids.has(data.id)) continue
    ids.add(data.id)
    const name = data.label ?? nameOf(data.id)
    const schema = schemaOf(data.id)
    const size = estimateSize([name, schema])
    const pos = n.position ?? { x: 0, y: 0 }
    nodes.push({
      id: data.id,
      type: 'table',
      position: { x: pos.x - size.width / 2, y: pos.y - size.height / 2 },
      data: {
        name,
        schema,
        kind: data.kind ?? 'table',
        focus: !!data.focus,
        ...(data.pinned ? { pinned: true } : {}),
        selfRef: !!data.self_ref,
        selfRefLastSeen: data.self_ref_last_seen,
        ...(data.self_ref_fks?.length ? { selfRefFks: data.self_ref_fks } : {}),
        ...(data.files?.length ? { files: data.files } : {}),
      },
    })
  }

  const edges: FlowEdge[] = []
  const edgeIds = new Set<string>()
  for (const e of savedEdges) {
    const info = e?.data
    if (!info?.id || edgeIds.has(info.id) || !ids.has(info.source) || !ids.has(info.target)) continue
    edgeIds.add(info.id)
    edges.push({ id: info.id, source: info.source, target: info.target, data: { info } })
  }

  return { nodes, edges, focusSchema, colorBy: parseColorBy(d.color_by) }
}
