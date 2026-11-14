// Pure helpers for the Concepts tab. No React, no fetch.
import {
  CONCEPT_RELATIONS,
  TABLE_RELATIONS,
  type Concept,
  type ConceptCreate,
  type ConceptStatus,
} from '../api/concepts'
import type { Relationship } from '../api/types'

export const CONCEPT_PREFIX = 'concept:'

/** "concept:<uuid>" -> the uuid. Anything else (a table name, a placeholder) -> null. */
export function conceptIdOf(table: string): string | null {
  return table.startsWith(CONCEPT_PREFIX) ? table.slice(CONCEPT_PREFIX.length) : null
}

/** The relations a link can carry, by what it points at. */
export function relationsFor(kind: 'table' | 'column' | 'concept'): readonly string[] {
  return kind === 'concept' ? CONCEPT_RELATIONS : TABLE_RELATIONS
}

/** The relation a new link starts with: `describes` for a table or column, `is_a` for a concept. */
export function defaultRelation(kind: 'table' | 'column' | 'concept'): string {
  return kind === 'concept' ? 'is_a' : 'describes'
}

/** Splits comma- or line-separated text into trimmed entries, dropping empties and repeats that differ only in case. */
export function parseList(text: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const part of text.split(/[,\n]/)) {
    const item = part.trim()
    const key = item.toLowerCase()
    if (item && !seen.has(key)) {
      seen.add(key)
      out.push(item)
    }
  }
  return out
}

/** The editable fields as the form holds them: lists are text. */
export interface Draft {
  name: string
  definition: string
  synonyms: string
  domain: string
  status: ConceptStatus
  tags: string
}

export const EMPTY_DRAFT: Draft = { name: '', definition: '', synonyms: '', domain: '', status: 'draft', tags: '' }

export function draftOf(c: Concept): Draft {
  return {
    name: c.name,
    definition: c.definition,
    synonyms: c.synonyms.join(', '),
    domain: c.domain ?? '',
    status: c.status,
    tags: c.tags.join(', '),
  }
}

/** The request body for a draft. An empty domain is `null`, which clears it on a patch. */
export function bodyOf(d: Draft): Required<ConceptCreate> {
  return {
    name: d.name.trim(),
    definition: d.definition,
    synonyms: parseList(d.synonyms),
    domain: d.domain.trim() || null,
    status: d.status,
    tags: parseList(d.tags),
  }
}

/** True when saving the draft would change the concept (list fields compare as lists, so spacing does not count). */
export function isDirty(d: Draft, c: Concept): boolean {
  const a = bodyOf(d)
  const b = bodyOf(draftOf(c))
  return JSON.stringify(a) !== JSON.stringify(b)
}

/** What a link points at, for a list: `main.sales.orders.customer_id`, `main.sales.orders` or the concept's name. */
export function targetLabel(link: Relationship, names: ReadonlyMap<string, string>): string {
  const id = conceptIdOf(link.target.table)
  if (id) return names.get(id) ?? `(deleted concept ${id.slice(0, 8)})`
  return link.target.column ? `${link.target.table}.${link.target.column}` : link.target.table
}

/** The same for the other end of an incoming link. */
export function sourceLabel(link: Relationship, names: ReadonlyMap<string, string>): string {
  const id = conceptIdOf(link.source.table)
  return id ? (names.get(id) ?? `(deleted concept ${id.slice(0, 8)})`) : link.source.table
}

/** File name for an export: the profile (made file-safe) and the day. */
export function exportName(profile: string | null, now: Date = new Date()): string {
  const day = now.toISOString().slice(0, 10)
  return `concepts-${(profile ?? 'profile').replace(/[^\w.-]+/g, '_')}-${day}.json`
}

/** Saves JSON as a file download. */
export function downloadJson(name: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
