import { describe, expect, it } from 'vitest'
import { fromDiagram, toDiagramBody } from './diagram'
import { deriveFlow } from './derive'
import { useGraphStore } from './graphStore'
import { filesTitle, hasFiles, nameLine, selfRefReasons } from './nodeMarks'
import type { FlowNode, EdgeFilters, TableNodeData } from './types'

type SavedNodes = Array<{ data: Record<string, unknown> }>
const data = (extra: Partial<TableNodeData> = {}): TableNodeData => ({ name: 'people', schema: 'c.s', kind: 'managed', focus: false, selfRef: false, ...extra })

describe('nameLine', () => {
  it('puts the ↻ before the name for any self-reference and the files mark after it', () => {
    expect(nameLine(data())).toBe('people')
    expect(nameLine(data({ selfRef: true }))).toBe('↻ people')
    expect(nameLine(data({ files: [{ path: 's3://b/', readable: true }] }))).toBe('people files')
  })
})

describe('selfRefReasons', () => {
  it('lists the keys, and says lineage only when lineage saw it', () => {
    const fk = { columns: ['manager_id'], parent_columns: ['person_id'], constraint: 'fk' }
    expect(selfRefReasons(data({ selfRef: true, selfRefFks: [fk] }))).toEqual({
      lineage: false,
      keys: [{ columns: ['manager_id'], parentColumns: ['person_id'], constraint: 'fk' }],
    })
    expect(selfRefReasons(data({ selfRef: true, selfRefLastSeen: 't', selfRefFks: [fk] })).lineage).toBe(true)
    expect(selfRefReasons(data({ selfRef: true })).lineage).toBe(true) // an old saved diagram: lineage only
    expect(selfRefReasons(data())).toEqual({ lineage: false, keys: [] })
  })
})

describe('files', () => {
  it('counts readable paths and hidden ones in the title', () => {
    expect(hasFiles(data())).toBe(false)
    expect(filesTitle([{ path: 's3://b/', readable: true }, { path: '', readable: false }])).toBe(
      'Loaded from files: 1 file source, 1 path not visible to you',
    )
  })
})

describe('the markers survive the store, a saved diagram and a reload', () => {
  const resp = {
    nodes: [
      {
        id: 'c.s.people',
        label: 'people',
        kind: 'managed',
        focus: true,
        self_ref: true,
        self_ref_fks: [{ columns: ['manager_id'], parent_columns: ['person_id'] }],
        files: [{ path: '', readable: false }],
      },
    ],
    edges: [],
    errors: [],
  }
  it('merges into node data, saves and loads', () => {
    useGraphStore.getState().clear()
    useGraphStore.getState().mergeRelations(resp)
    const node = useGraphStore.getState().nodes[0]
    expect(node.data.selfRef).toBe(true)
    expect(node.data.selfRefFks?.[0].columns).toEqual(['manager_id'])
    expect(node.data.files?.[0].readable).toBe(false)
    const saved = toDiagramBody('d', { nodes: [node], edges: [], focusSchema: 'c.s' })
    expect((saved.nodes as SavedNodes)[0].data).toMatchObject({ self_ref: true, self_ref_fks: resp.nodes[0].self_ref_fks, files: resp.nodes[0].files })
    const back = fromDiagram({ ...saved, saved_at: '' } as never).nodes[0]
    expect(back.data.selfRefFks).toEqual(node.data.selfRefFks)
    expect(back.data.files).toEqual(node.data.files)
  })
  it('a node with neither fact saves neither key', () => {
    const n: FlowNode = { id: 'c.s.t', type: 'table', position: { x: 0, y: 0 }, data: data() }
    const saved = toDiagramBody('d', { nodes: [n], edges: [], focusSchema: 'c.s' })
    const savedData = (saved.nodes as SavedNodes)[0].data
    expect('files' in savedData || 'self_ref_fks' in savedData).toBe(false)
    const filters = { lineage: true, showSuperseded: false, showRejected: false } as unknown as EdgeFilters
    expect(deriveFlow({ nodes: [n], edges: [], focusSchema: 'c.s', filters, hoverId: null }).nodes[0].data.selfRef).toBe(false)
  })
})
