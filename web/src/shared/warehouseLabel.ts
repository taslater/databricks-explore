/** What a warehouse reads as in a list: its name and its state, unless the name already says the state. */
export function warehouseLabel(name: string, state: string | null | undefined): string {
  const s = (state ?? '').trim().toLowerCase()
  if (s === '') return name
  const escaped = s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // "(stopped)", "[stopped]", "- stopped" and a bare trailing word all count as the state being said already.
  if (new RegExp(`(^|[\\s(\\[-])${escaped}[)\\]]?\\s*$`, 'i').test(name)) return name
  return `${name} (${s})`
}
