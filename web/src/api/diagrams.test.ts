import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from './client'
import { DiagramConflict, deleteDiagram, getDiagramRevision, renameDiagram, saveDiagramChecked, storedName } from './diagrams'

function reply(status: number, body: unknown) {
  const fetchMock = vi.fn().mockResolvedValue({ status, ok: status < 400, text: async () => JSON.stringify(body) })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => vi.unstubAllGlobals())

describe('saveDiagramChecked', () => {
  it('sends the base revision in X-Base-Revision and returns the saved response', async () => {
    const fetchMock = reply(200, { saved: 'g', revision: 5 })
    expect(await saveDiagramChecked({ name: 'g' }, 4)).toEqual({ saved: 'g', revision: 5 })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/diagrams')
    expect(init.method).toBe('POST')
    expect(init.headers['X-Base-Revision']).toBe('4')
    expect(init.headers['Content-Type']).toBe('application/json')
  })

  it('sends no header without a base revision, so nothing is checked', async () => {
    const fetchMock = reply(200, { saved: 'g', revision: 1 })
    await saveDiagramChecked({ name: 'g' }, null)
    expect(fetchMock.mock.calls[0][1].headers['X-Base-Revision']).toBeUndefined()
  })

  it('turns a 409 into a DiagramConflict that carries the newer revision', async () => {
    reply(409, { error: 'graph g was saved by agent since revision 4 (now revision 6)', name: 'g', revision: 6, by: 'agent' })
    const err = await saveDiagramChecked({ name: 'g' }, 4).catch((e) => e)
    expect(err).toBeInstanceOf(DiagramConflict)
    expect(err.remote).toEqual({ name: 'g', revision: 6, by: 'agent' })
    expect(err.message).toContain('saved by agent')
  })

  it('throws an ApiError with the server message for any other failure', async () => {
    reply(400, { error: 'name: required' })
    const err = await saveDiagramChecked({ name: '' }, null).catch((e) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err.status).toBe(400)
    expect(err.message).toBe('name: required')
  })
})

describe('revision, rename and delete', () => {
  it('reads a revision with the name encoded', async () => {
    const fetchMock = reply(200, { name: 'a b', revision: 2, by: 'ui' })
    expect(await getDiagramRevision('a b')).toEqual({ name: 'a b', revision: 2, by: 'ui' })
    expect(fetchMock.mock.calls[0][0]).toBe('/api/diagrams/a%20b/revision')
  })

  it('reports a missing graph as an ApiError 404', async () => {
    reply(404, { error: 'graph not found: g' })
    const err = await getDiagramRevision('g').catch((e) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err.status).toBe(404)
  })

  it('renames with POST and deletes with DELETE', async () => {
    let fetchMock = reply(200, { renamed: 'new', revision: 3 })
    expect(await renameDiagram('old', 'new')).toEqual({ renamed: 'new', revision: 3 })
    expect(fetchMock.mock.calls[0][0]).toBe('/api/diagrams/old/rename')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ new_name: 'new' })
    fetchMock = reply(200, { deleted: 'new', trash: 'new.1.json' })
    expect((await deleteDiagram('new')).trash).toBe('new.1.json')
    expect(fetchMock.mock.calls[0][1].method).toBe('DELETE')
  })
})

describe('storedName', () => {
  it('matches the server: other characters become _', () => {
    expect(storedName('Returns graph')).toBe('Returns_graph')
    expect(storedName('  a/b.c-d  ')).toBe('a_b.c-d')
  })
})
