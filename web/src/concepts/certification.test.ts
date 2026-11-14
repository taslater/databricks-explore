import { describe, expect, it } from 'vitest'
import type { Certification } from '../api/concepts'
import { certificationLabel, certificationOf, withCertification } from './certification'

const CERT: Certification = {
  tables: { 'main.sales.orders': 'certified', 'main.sales.old': 'deprecated' },
  columns: { 'main.sales.orders#amount': 'certified' },
  ignored: 0,
  truncated: false,
  fetched_at: '2026-11-14T11:00:00+00:00',
}

describe('certificationLabel', () => {
  const now = Date.parse('2026-11-14T12:00:00Z')

  it('says not loaded when nothing was cached', () => {
    expect(certificationLabel(null, now)).toBe('Certification: not loaded')
    expect(certificationLabel(undefined, now)).toBe('Certification: not loaded')
    expect(certificationLabel('garbage', now)).toBe('Certification: not loaded')
  })

  it('shows the age in the largest whole unit', () => {
    expect(certificationLabel('2026-11-14T11:59:40Z', now)).toBe('Certification: just now')
    expect(certificationLabel('2026-11-14T11:15:00+00:00', now)).toBe('Certification: 45 min ago')
    expect(certificationLabel('2026-11-14T09:00:00Z', now)).toBe('Certification: 3 h ago')
    expect(certificationLabel('2026-11-11T12:00:00Z', now)).toBe('Certification: 3 d ago')
  })

  it('treats a time slightly in the future as just now', () => {
    expect(certificationLabel('2026-11-14T12:00:30Z', now)).toBe('Certification: just now')
  })
})

describe('certificationOf', () => {
  it('reads a table or a column', () => {
    expect(certificationOf(CERT, 'main.sales.orders')).toBe('certified')
    expect(certificationOf(CERT, 'main.sales.old', null)).toBe('deprecated')
    expect(certificationOf(CERT, 'main.sales.orders', 'amount')).toBe('certified')
  })

  it('has nothing for an untagged target or before anything was read', () => {
    expect(certificationOf(CERT, 'main.sales.customers')).toBeUndefined()
    expect(certificationOf(CERT, 'main.sales.old', 'id')).toBeUndefined()
    expect(certificationOf(undefined, 'main.sales.orders')).toBeUndefined()
  })
})

describe('withCertification', () => {
  const nodes = [
    { id: 'main.sales.orders', data: { name: 'orders' } },
    { id: 'main.sales.customers', data: { name: 'customers' } },
  ]

  it('adds the status to tagged nodes only and leaves the others the same object', () => {
    const out = withCertification(nodes, CERT)
    expect(out[0].data).toEqual({ name: 'orders', certification: 'certified' })
    expect(out[1]).toBe(nodes[1])
    expect(nodes[0].data).toEqual({ name: 'orders' })
  })

  it('returns the input when there is nothing to add', () => {
    expect(withCertification(nodes, undefined)).toBe(nodes)
    expect(withCertification(nodes, { ...CERT, tables: {} })).toBe(nodes)
  })
})
