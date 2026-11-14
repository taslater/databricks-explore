// Sketch node and connector types. They match contracts/canvas.schema.json (version 2) field for field,
// so the objects in the sketch store are exactly what the canvas file holds. No React or store imports.

export type ShapeKind = 'rect' | 'rounded' | 'ellipse' | 'diamond' | 'cylinder'

/** Node types the sketch module owns. A canvas also has query, chart, note and table windows, which it owns itself. */
export type SketchType = 'shape' | 'text' | 'sticky' | 'frame' | 'placeholder'

export const SKETCH_TYPES: readonly SketchType[] = ['shape', 'text', 'sticky', 'frame', 'placeholder']
export const SHAPE_KINDS: readonly ShapeKind[] = ['rect', 'rounded', 'ellipse', 'diamond', 'cylinder']

export function isSketchType(t: string): t is SketchType {
  return (SKETCH_TYPES as readonly string[]).includes(t)
}

export interface Point {
  x: number
  y: number
}

export interface Size {
  w: number
  h: number
}

export type KeyMarker = 'pk' | 'fk'

export interface PlaceholderColumn {
  name: string
  type: string
  key?: KeyMarker
}

/** A table that does not exist yet. Its id is a UUID, and the relationship store knows it as `ph:<id>`. */
export interface PlaceholderSpec {
  id: string
  name: string
  columns: PlaceholderColumn[]
  /** Full name of the real table this one stands for, once it exists. */
  linked?: string | null
}

export interface SketchNode {
  id: string
  type: SketchType
  position: Point
  size: Size
  /** Text on a shape, text, sticky or frame. */
  label?: string
  /** Required when type is shape. */
  shape?: ShapeKind
  fill?: string
  stroke?: string
  font_size?: number
  locked?: boolean
  /** Stacking order. Higher is in front. */
  z?: number
  /** Required when type is placeholder. */
  placeholder?: PlaceholderSpec
  collapsed?: boolean
}

export type LineKind = 'straight' | 'step' | 'curve'
export type Side = 't' | 'r' | 'b' | 'l'

export interface RelationshipRef {
  /** Id of the `sketch` edge saved in the relationship store. */
  id?: string
  source_column?: string
  target_column?: string
}

/** A user-drawn connector. Version 2 files hold them in a top-level `edges` list. */
export interface SketchEdge {
  id: string
  source: string
  target: string
  source_handle?: Side
  target_handle?: Side
  line: LineKind
  arrow_start: boolean
  arrow_end: boolean
  dashed: boolean
  label?: string
  color?: string
  relationship?: RelationshipRef
}

/** Position, size and stacking of one node. What undo restores and what align and order change. */
export interface Geometry {
  position: Point
  size: Size
  z?: number
}

/** What the sketch module needs to know about a node the host owns (a query window, note or table card). */
export interface HostNode extends Geometry {
  id: string
  type: string
  locked?: boolean
  /** The window's title, for the properties panel. */
  title?: string
  /** For a table card: the full name of its table. Connectors to it can be saved as relationships. */
  table?: string
  /** True when the Delete key may remove it (a table card holds nothing that cannot be fetched again). */
  removable?: boolean
}

/**
 * The seam between the sketch module and whatever mounts it. The Canvas implements it over its windows.
 * A later host, such as the Graph tab, implements the same three methods over its own nodes.
 */
export interface SketchHost {
  /** Every node the host owns, with its current geometry. */
  nodes: () => HostNode[]
  /** Writes geometry and lock changes to host nodes. Unknown ids are ignored. */
  patch: (patches: Record<string, Partial<Geometry> & { locked?: boolean }>) => void
  /** Removes host nodes. Called only for nodes that said they are `removable`. Not part of undo. */
  remove?: (ids: string[]) => void
}

export const EMPTY_HOST: SketchHost = { nodes: () => [], patch: () => undefined }

/** Tools in the palette. `connect` makes handles easy to grab. The others place a node of that kind. */
export type Tool =
  | 'select'
  | 'hand'
  | 'connect'
  | 'rect'
  | 'rounded'
  | 'ellipse'
  | 'diamond'
  | 'cylinder'
  | 'text'
  | 'sticky'
  | 'frame'
  | 'placeholder'

export const PLACING_TOOLS: readonly Tool[] = [
  'rect',
  'rounded',
  'ellipse',
  'diamond',
  'cylinder',
  'text',
  'sticky',
  'frame',
  'placeholder',
]

export function isPlacingTool(t: Tool): boolean {
  return PLACING_TOOLS.includes(t)
}
