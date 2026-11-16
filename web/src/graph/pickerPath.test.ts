import { describe, expect, it } from 'vitest'
import { completeLast, pathPrefix, resolvePath, splitPath } from './pickerPath'

const catalogs = ['dev', 'Prod', 'my.cat']
const schemas: Record<string, string[]> = { dev: ['hr', 'sales'], 'my.cat': ['sch'] }
const schemasOf = (c: string) => schemas[c] ?? null

describe('splitPath', () => {
  it('splits on dots', () => {
    expect(splitPath('dev.hr.emp')).toEqual({ done: ['dev', 'hr'], last: 'emp', head: 'dev.hr.' })
    expect(splitPath('dev.')).toEqual({ done: ['dev'], last: '', head: 'dev.' })
    expect(splitPath('abc')).toEqual({ done: [], last: 'abc', head: '' })
  })

  it('keeps dots inside backticks', () => {
    expect(splitPath('`my.cat`.sch')).toEqual({ done: ['my.cat'], last: 'sch', head: '`my.cat`.' })
  })
})

describe('resolvePath', () => {
  it('lists catalogs while no segment is complete', () => {
    expect(resolvePath('de', catalogs, schemasOf)).toMatchObject({ catalog: null, filter: 'de', problem: null })
  })

  it('drills into a completed catalog, ignoring case', () => {
    expect(resolvePath('DEV.', catalogs, schemasOf)).toMatchObject({ catalog: 'dev', schema: null, filter: '' })
    expect(resolvePath('dev.hr', catalogs, schemasOf)).toMatchObject({ catalog: 'dev', schema: null, filter: 'hr' })
  })

  it('drills into a completed schema and filters objects', () => {
    expect(resolvePath('dev.hr.emp', catalogs, schemasOf)).toMatchObject({
      catalog: 'dev',
      schema: 'hr',
      filter: 'emp',
    })
  })

  it('does not drill into a segment that matches nothing, and says so', () => {
    expect(resolvePath('foo.', catalogs, schemasOf)).toMatchObject({ catalog: null, problem: 'no catalog named foo' })
    expect(resolvePath('dev.zz.', catalogs, schemasOf)).toMatchObject({
      catalog: 'dev',
      schema: null,
      problem: 'no schema named zz in dev',
    })
  })

  it('waits for data that is not loaded', () => {
    expect(resolvePath('dev.', null, schemasOf).pending).toBe(true)
    expect(resolvePath('Prod.x.', catalogs, schemasOf)).toMatchObject({ catalog: 'Prod', pending: true })
  })

  it('reads backtick-quoted names with dots', () => {
    expect(resolvePath('`my.cat`.sch.t', catalogs, schemasOf)).toMatchObject({
      catalog: 'my.cat',
      schema: 'sch',
      filter: 't',
    })
  })
})

describe('pathPrefix and completeLast', () => {
  it('builds the text for a drill position', () => {
    expect(pathPrefix({ catalog: null, schema: null })).toBe('')
    expect(pathPrefix({ catalog: 'dev', schema: null })).toBe('dev.')
    expect(pathPrefix({ catalog: 'my.cat', schema: 'sch' })).toBe('`my.cat`.sch.')
  })

  it('replaces the last segment', () => {
    expect(completeLast('dev.h', 'hr', true)).toBe('dev.hr.')
    expect(completeLast('dev.hr.em', 'employees', false)).toBe('dev.hr.employees')
    expect(completeLast('my', 'my.cat', true)).toBe('`my.cat`.')
  })
})
