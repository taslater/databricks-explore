import { describe, expect, it } from 'vitest'
import { warehouseLabel } from './warehouseLabel'

describe('warehouseLabel', () => {
  it('appends the state in lowercase', () => {
    expect(warehouseLabel('Demo Pro', 'STOPPED')).toBe('Demo Pro (stopped)')
    expect(warehouseLabel('Demo Serverless', 'Running')).toBe('Demo Serverless (running)')
  })
  it('does not repeat a state the name already carries', () => {
    expect(warehouseLabel('Demo Pro (stopped)', 'STOPPED')).toBe('Demo Pro (stopped)')
    expect(warehouseLabel('Demo Pro [Stopped]', 'STOPPED')).toBe('Demo Pro [Stopped]')
    expect(warehouseLabel('Demo Pro - stopped', 'STOPPED')).toBe('Demo Pro - stopped')
    expect(warehouseLabel('Nightly stopped', 'STOPPED')).toBe('Nightly stopped')
  })
  it('still adds a state that only appears elsewhere in the name', () => {
    expect(warehouseLabel('Stopped jobs', 'STOPPED')).toBe('Stopped jobs (stopped)')
    expect(warehouseLabel('Pro (stopped) copy', 'STOPPED')).toBe('Pro (stopped) copy (stopped)')
  })
  it('leaves the name alone without a state', () => {
    expect(warehouseLabel('Demo Pro', null)).toBe('Demo Pro')
    expect(warehouseLabel('Demo Pro', undefined)).toBe('Demo Pro')
    expect(warehouseLabel('Demo Pro', '')).toBe('Demo Pro')
  })
})
