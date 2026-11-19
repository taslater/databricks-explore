import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DiagramRevision } from '../api/diagrams'

const { api, revisionApi } = vi.hoisted(() => ({ api: { getDiagram: vi.fn() }, revisionApi: { getDiagramRevision: vi.fn() } }))
vi.mock('../api/client', async (original) => ({ ...(await original<object>()), ...api }))
vi.mock('../api/diagrams', async (original) => ({ ...(await original<object>()), ...revisionApi }))

import { ApiError } from '../api/client'
import { currentSignature, decideDiagramSync, graphSignature, handleDiagramRemote, pollDiagramNow, reloadOpenDiagram } from './diagramSync'
import { useGraphStore } from './graphStore'
import type { FlowEdge, FlowNode } from './types'

const rev = (revision: number, by: DiagramRevision['by'] = 'agent'): DiagramRevision => ({ name: 'g', revision, by })
const node = (id: string, x = 0, y = 0, extra = {}): FlowNode => ({
  id,
  type: 'table',
  position: { x, y },
  data: { name: id, schema: 's', kind: 'table', focus: false, selfRef: false, ...extra },
})
const edge = (id: string): FlowEdge => ({ id, source: 'a', target: 'b' })

const file = (ids: string[]) => ({
  name: 'g',
  saved_at: 'now',
  focus_schema: null,
  nodes: ids.map((id, i) => ({ data: { id, label: id }, position: { x: i * 300, y: 0 } })),
  edges: [],
})

function open(revision: number) {
  useGraphStore.getState().setOpenDiagram({ name: 'g', revision, signature: currentSignature() })
}

beforeEach(() => {
  api.getDiagram.mockReset()
  revisionApi.getDiagramRevision.mockReset()
  useGraphStore.getState().clear()
  useGraphStore.setState({ nodes: [node('a.b.t1')], edges: [], diagramSaving: false })
  open(3)
})

describe('graphSignature', () => {
  it('ignores order and measured sizes, and sees a move, a pin, a new node or a new edge', () => {
    const base = graphSignature([node('x', 1, 2), node('y')], [edge('e1')], 's')
    expect(graphSignature([node('y'), node('x', 1, 2)], [edge('e1')], 's')).toBe(base)
    expect(graphSignature([{ ...node('x', 1, 2), measured: { width: 99, height: 9 } }, node('y')], [edge('e1')], 's')).toBe(base)
    expect(graphSignature([node('x', 5, 2), node('y')], [edge('e1')], 's')).not.toBe(base)
    expect(graphSignature([node('x', 1, 2, { pinned: true }), node('y')], [edge('e1')], 's')).not.toBe(base)
    expect(graphSignature([node('x', 1, 2), node('y'), node('z')], [edge('e1')], 's')).not.toBe(base)
    expect(graphSignature([node('x', 1, 2), node('y')], [edge('e1'), edge('e2')], 's')).not.toBe(base)
  })
})

describe('decideDiagramSync', () => {
  const known = { name: 'g', revision: 3, signature: '' }
  it('does nothing without a newer revision, for another graph, or mid-save', () => {
    expect(decideDiagramSync(known, rev(3), false, false)).toBe('none')
    expect(decideDiagramSync(known, rev(2), false, false)).toBe('none')
    expect(decideDiagramSync(null, rev(9), false, false)).toBe('none')
    expect(decideDiagramSync(known, { ...rev(9), name: 'other' }, false, false)).toBe('none')
    expect(decideDiagramSync(known, rev(4), false, true)).toBe('none')
  })
  it('reloads without unsaved changes and asks with some', () => {
    expect(decideDiagramSync(known, rev(4), false, false)).toBe('reload')
    expect(decideDiagramSync(known, rev(4), true, false)).toBe('banner')
  })
})

describe('handleDiagramRemote', () => {
  it('reloads an agent change in place when the page holds nothing unsaved', async () => {
    api.getDiagram.mockResolvedValue(file(['a.b.t1', 'a.b.t2']))
    expect(await handleDiagramRemote(rev(4))).toBe('reload')
    const g = useGraphStore.getState()
    expect(g.nodes.map((n) => n.id)).toEqual(['a.b.t1', 'a.b.t2'])
    expect(g.openDiagram?.revision).toBe(4)
    expect(g.openDiagram?.signature).toBe(currentSignature()) // loading is not an edit
    expect(g.status.text).toContain('changed by agent and was reloaded')
  })

  it('asks instead when the person moved something, and asks once per revision', async () => {
    useGraphStore.setState({ nodes: [node('a.b.t1', 50, 50)] })
    expect(await handleDiagramRemote(rev(4))).toBe('banner')
    expect(api.getDiagram).not.toHaveBeenCalled()
    expect(useGraphStore.getState().diagramChanged).toEqual(rev(4))
    expect(useGraphStore.getState().nodes[0].position).toEqual({ x: 50, y: 50 })
  })

  it('does nothing about its own write while a save is in flight', async () => {
    useGraphStore.setState({ diagramSaving: true })
    expect(await handleDiagramRemote(rev(4))).toBe('none')
    expect(api.getDiagram).not.toHaveBeenCalled()
  })

  it('does not reload over changes made while the file was being fetched, but Reload (force) does', async () => {
    api.getDiagram.mockImplementation(async () => {
      useGraphStore.setState({ nodes: [node('a.b.t1', 9, 9)] })
      return file(['a.b.t9'])
    })
    expect(await handleDiagramRemote(rev(4))).toBe('none')
    expect(useGraphStore.getState().nodes.map((n) => n.id)).toEqual(['a.b.t1'])
    expect(await reloadOpenDiagram(rev(4), true)).toBe(true)
    expect(useGraphStore.getState().nodes.map((n) => n.id)).toEqual(['a.b.t9'])
    expect(useGraphStore.getState().diagramChanged).toBeNull()
  })
})

describe('pollDiagramNow', () => {
  it('applies the revision the server answers', async () => {
    revisionApi.getDiagramRevision.mockResolvedValue(rev(4))
    api.getDiagram.mockResolvedValue(file(['a.b.t1', 'a.b.t2']))
    await pollDiagramNow()
    expect(useGraphStore.getState().nodes).toHaveLength(2)
  })

  it('says so when the graph was deleted or renamed outside, and stops polling it', async () => {
    revisionApi.getDiagramRevision.mockRejectedValue(new ApiError(404, 'graph not found: g'))
    await pollDiagramNow()
    const g = useGraphStore.getState()
    expect(g.openDiagram).toBeNull()
    expect(g.status).toEqual({ text: expect.stringContaining('deleted or renamed'), error: true })
    expect(g.nodes).toHaveLength(1) // what is on screen stays
  })

  it('ignores other errors and does nothing for a graph that was never saved', async () => {
    revisionApi.getDiagramRevision.mockRejectedValue(new Error('offline'))
    await pollDiagramNow()
    expect(useGraphStore.getState().openDiagram?.name).toBe('g')
    useGraphStore.getState().setOpenDiagram(null)
    revisionApi.getDiagramRevision.mockClear()
    await pollDiagramNow()
    expect(revisionApi.getDiagramRevision).not.toHaveBeenCalled()
  })
})
