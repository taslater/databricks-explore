import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CanvasDoc } from './types'
import { saveCanvasChecked, SaveConflict } from './agent'
import { ApiError } from './client'

const doc = { version: 2, name: 'd', profile: null, windows: [] } as CanvasDoc

function reply(status: number, body: unknown) {
  const fetchMock = vi.fn().mockResolvedValue({ status, ok: status < 400, text: async () => JSON.stringify(body) })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => vi.unstubAllGlobals())

describe('saveCanvasChecked', () => {
  it('sends the base revision in X-Base-Revision and returns the saved response', async () => {
    const fetchMock = reply(200, { saved: 'd', revision: 5 })
    expect(await saveCanvasChecked(doc, 4)).toEqual({ saved: 'd', revision: 5 })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/canvases')
    expect(init.method).toBe('POST')
    expect(init.headers['X-Base-Revision']).toBe('4')
  })

  it('sends no header without a base revision, so nothing is checked', async () => {
    const fetchMock = reply(200, { saved: 'd', revision: 1 })
    await saveCanvasChecked(doc, null)
    expect(fetchMock.mock.calls[0][1].headers['X-Base-Revision']).toBeUndefined()
  })

  it('turns a 409 into a SaveConflict that carries the canvas as it is now', async () => {
    reply(409, { error: 'canvas d was saved by agent since revision 4 (now revision 6)', name: 'd', revision: 6, by: 'agent', snapshots: 2 })
    const err = await saveCanvasChecked(doc, 4).catch((e) => e)
    expect(err).toBeInstanceOf(SaveConflict)
    expect(err.remote).toEqual({ name: 'd', revision: 6, by: 'agent', snapshots: 2 })
    expect(err.message).toContain('saved by agent')
  })

  it('reports any other failure as an ApiError with the server message', async () => {
    reply(400, { error: 'name: bad' })
    const err = await saveCanvasChecked(doc, null).catch((e) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err.message).toBe('name: bad')
  })
})
