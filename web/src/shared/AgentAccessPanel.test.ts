import { describe, expect, it } from 'vitest'
import { maskToken } from './AgentAccessPanel'

describe('maskToken', () => {
  it('hides the token wherever it appears and keeps the rest of the command', () => {
    const command = 'claude mcp add --transport http databricks-explore http://127.0.0.1:8765/mcp --header "Authorization: Bearer s3cr3t"'
    const shown = maskToken(command, 's3cr3t')
    expect(shown).not.toContain('s3cr3t')
    expect(shown).toContain('Bearer ')
    expect(shown.startsWith('claude mcp add --transport http databricks-explore http://127.0.0.1:8765/mcp')).toBe(true)
  })

  it('leaves the command alone when there is no token', () => {
    expect(maskToken('abc', '')).toBe('abc')
  })
})
