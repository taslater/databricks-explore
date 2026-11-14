import { describe, expect, it } from 'vitest'
import type { Certification } from '../api/concepts'
import { certificationOf, withCertification } from './certification'

const CERT: Certification = {
  tables: { 'main.sales.orders': 'certified', 'main.sales.old': 'deprecated' },
  columns: { 'main.sales.orders#amount': 'certified' },
  ignored: 0,
  truncated: false,
}

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
