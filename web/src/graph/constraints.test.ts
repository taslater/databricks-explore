import { describe, expect, it } from 'vitest'
import { formatConstraint, formatConstraints } from './constraints'

describe('formatConstraint', () => {
  it('reads a primary key', () => {
    expect(formatConstraint({ primary_key_constraint: { name: 'pk', child_columns: ['order_id', 'line_no'] } })).toBe(
      'Primary key: order_id, line_no',
    )
  })

  it('reads a foreign key with its name and the parent column', () => {
    expect(
      formatConstraint({
        foreign_key_constraint: {
          name: 'fk_x',
          child_columns: ['order_id'],
          parent_table: 'demo.sales.orders',
          parent_columns: ['order_id'],
        },
      }),
    ).toBe('Foreign key fk_x: order_id → demo.sales.orders.order_id')
  })

  it('reads a composite foreign key and one with no name', () => {
    expect(
      formatConstraint({
        foreign_key_constraint: { child_columns: ['a', 'b'], parent_table: 'c.s.t', parent_columns: ['x', 'y'] },
      }),
    ).toBe('Foreign key: (a, b) → c.s.t (x, y)')
  })

  it('reads a constraint that only has a name', () => {
    expect(formatConstraint({ named_table_constraint: { name: 'positive_qty' } })).toBe('Constraint positive_qty')
  })

  it('keeps an unknown shape as JSON, and survives junk', () => {
    expect(formatConstraint({ something_new: { a: 1 } })).toBe('{"something_new":{"a":1}}')
    expect(formatConstraint(null)).toBe('null')
    expect(formatConstraint({ primary_key_constraint: {} })).toBe('Primary key: ')
  })

  it('formats a list, in order, and an absent list as nothing', () => {
    expect(formatConstraints(undefined)).toEqual([])
    expect(
      formatConstraints([{ primary_key_constraint: { child_columns: ['id'] } }, { named_table_constraint: { name: 'n' } }]),
    ).toEqual(['Primary key: id', 'Constraint n'])
  })
})
