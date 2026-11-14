import { describe, expect, it } from 'vitest'
import type { Concept } from '../api/concepts'
import { conceptsQuery } from '../api/concepts'
import type { Relationship } from '../api/types'
import {
  bodyOf,
  conceptIdOf,
  defaultRelation,
  draftOf,
  EMPTY_DRAFT,
  exportName,
  isDirty,
  parseList,
  relationsFor,
  sourceLabel,
  targetLabel,
} from './model'

const ID1 = '7f0c2d3e-1111-4222-8333-444455556666'
const ID2 = '8a0c2d3e-1111-4222-8333-444455556666'

function concept(id: string, name: string, extra: Partial<Concept> = {}): Concept {
  return {
    id,
    name,
    definition: '',
    synonyms: [],
    domain: null,
    status: 'draft',
    tags: [],
    provenance: { origin: 'manual' },
    created_at: 't',
    updated_at: 't',
    ...extra,
  }
}

function link(id: string, conceptId: string, table: string, relation: string, column: string | null = null): Relationship {
  return {
    id,
    kind: 'concept_link',
    source: { table: `concept:${conceptId}` },
    target: { table, column },
    directed: true,
    provenance: { origin: 'user' },
    evidence: null,
    status: 'accepted',
    note: '',
    relation,
    created_at: 't',
    updated_at: 't',
  }
}

const A = 'main.sales.orders'

describe('parseList', () => {
  it('splits on commas and new lines, trims, and drops empties and case repeats', () => {
    expect(parseList(' client, Buyer\n\nCLIENT ,, account holder ')).toEqual(['client', 'Buyer', 'account holder'])
    expect(parseList('')).toEqual([])
  })
})

describe('drafts', () => {
  const c = concept(ID1, 'Customer', { synonyms: ['client', 'buyer'], domain: 'Sales', tags: ['core'], definition: 'Buys.' })

  it('round-trips a concept through its draft', () => {
    expect(bodyOf(draftOf(c))).toEqual({
      name: 'Customer',
      definition: 'Buys.',
      synonyms: ['client', 'buyer'],
      domain: 'Sales',
      status: 'draft',
      tags: ['core'],
    })
  })

  it('turns an empty domain into null, so a patch clears it', () => {
    expect(bodyOf({ ...EMPTY_DRAFT, name: ' x ', domain: '  ' })).toMatchObject({ name: 'x', domain: null })
  })

  it('is dirty only when a value changes, not its spacing', () => {
    const d = draftOf(c)
    expect(isDirty(d, c)).toBe(false)
    expect(isDirty({ ...d, synonyms: 'client,buyer' }, c)).toBe(false)
    expect(isDirty({ ...d, status: 'certified' }, c)).toBe(true)
    expect(isDirty({ ...d, domain: '' }, c)).toBe(true)
  })
})

describe('links', () => {
  it('offers the relations that fit the target', () => {
    expect(relationsFor('table')).toEqual(['defines', 'measures', 'identifies', 'describes'])
    expect(relationsFor('column')).toEqual(relationsFor('table'))
    expect(relationsFor('concept')).toEqual(['is_a', 'part_of', 'related_to'])
    expect(relationsFor('table')).toContain(defaultRelation('column'))
    expect(relationsFor('concept')).toContain(defaultRelation('concept'))
  })

  it('reads a concept id out of an endpoint', () => {
    expect(conceptIdOf(`concept:${ID1}`)).toBe(ID1)
    expect(conceptIdOf(A)).toBeNull()
    expect(conceptIdOf('ph:abc')).toBeNull()
  })

  it('labels targets and sources', () => {
    const names = new Map([[ID1, 'Customer']])
    expect(targetLabel(link('e1', ID2, A, 'defines', 'id'), names)).toBe('main.sales.orders.id')
    expect(targetLabel(link('e1', ID2, A, 'defines'), names)).toBe(A)
    expect(targetLabel(link('e1', ID2, `concept:${ID1}`, 'is_a'), names)).toBe('Customer')
    expect(targetLabel(link('e1', ID2, `concept:${ID2}`, 'is_a'), names)).toContain('deleted concept')
    expect(sourceLabel(link('e1', ID1, A, 'defines'), names)).toBe('Customer')
  })
})

describe('request helpers', () => {
  it('builds the list query string from the filters that are set', () => {
    expect(conceptsQuery({ q: '', domain: '', status: '' })).toBe('')
    expect(conceptsQuery({ q: ' client ', domain: 'Sales', status: 'certified' })).toBe('?q=client&domain=Sales&status=certified')
  })

  it('names an export after the profile and the day, with nothing unsafe in it', () => {
    expect(exportName('my profile/x', new Date('2026-11-13T10:00:00Z'))).toBe('concepts-my_profile_x-2026-11-13.json')
    expect(exportName(null, new Date('2026-11-13T10:00:00Z'))).toBe('concepts-profile-2026-11-13.json')
  })
})
