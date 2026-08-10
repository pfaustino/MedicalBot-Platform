import { z } from 'zod'
import { CONDITION_KEYS, CONDITION_LABELS, type ConditionKey } from './profile.js'
import { ICD_CONDITION_CATALOG } from './reference/icd-conditions.js'

export interface ConditionSearchResult {
  /** Stable key stored on the user row. */
  key: string
  name: string
  icdCode: string | null
  /** When set, links to a `@medbot/conditions` tracking module. */
  moduleKey: ConditionKey | null
  hasModule: boolean
  source: 'module' | 'icd' | 'custom'
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
}

export function normalizeIcdCode(code: string): string {
  return code.trim().toUpperCase().replace(/\s+/g, '')
}

export function buildConditionKey(input: {
  name: string
  moduleKey?: string | null
  icdCode?: string | null
}): string {
  if (input.moduleKey && CONDITION_KEYS.includes(input.moduleKey as ConditionKey)) {
    return input.moduleKey
  }
  if (input.icdCode?.trim()) {
    return `icd:${normalizeIcdCode(input.icdCode).replace(/\./g, '')}`
  }
  return `custom:${slugify(input.name)}`
}

export function searchConditionCatalog(query: string, limit = 20): ConditionSearchResult[] {
  const q = query.trim().toLowerCase()
  const results: ConditionSearchResult[] = []
  const seen = new Set<string>()

  const add = (r: ConditionSearchResult) => {
    if (seen.has(r.key)) return
    seen.add(r.key)
    results.push(r)
  }

  for (const key of CONDITION_KEYS) {
    const label = CONDITION_LABELS[key]
    if (!q || label.toLowerCase().includes(q) || key.includes(q)) {
      add({
        key,
        name: label,
        icdCode: null,
        moduleKey: key,
        hasModule: false,
        source: 'module',
      })
    }
  }

  for (const entry of ICD_CONDITION_CATALOG) {
    const code = normalizeIcdCode(entry.code)
    const hay = `${entry.name} ${code}`.toLowerCase()
    if (!q || hay.includes(q)) {
      add({
        key: buildConditionKey({ name: entry.name, icdCode: code }),
        name: entry.name,
        icdCode: entry.code,
        moduleKey: null,
        hasModule: false,
        source: 'icd',
      })
    }
  }

  if (q.length >= 2) {
    add({
      key: buildConditionKey({ name: query.trim() }),
      name: query.trim(),
      icdCode: null,
      moduleKey: null,
      hasModule: false,
      source: 'custom',
    })
  }

  return results.slice(0, limit)
}

/** Create payload for POST /conditions — supports any diagnosis, not just enum keys. */
export const conditionCreateSchema = z.object({
  name: z.string().min(1).max(200),
  moduleKey: z.enum(CONDITION_KEYS).nullish(),
  icdCode: z.string().max(20).nullish(),
  diagnosedAt: z.coerce.date().nullable().default(null),
  status: z.enum(['active', 'remission', 'resolved']).default('active'),
  managingProviderId: z.string().uuid().nullable().default(null),
  notes: z.string().max(2000).nullable().default(null),
})

export type ConditionCreateInput = z.infer<typeof conditionCreateSchema>

export function resolveConditionCreate(input: ConditionCreateInput) {
  const key = buildConditionKey({
    name: input.name,
    moduleKey: input.moduleKey,
    icdCode: input.icdCode,
  })
  const displayName =
    input.moduleKey && CONDITION_LABELS[input.moduleKey]
      ? CONDITION_LABELS[input.moduleKey]
      : input.name.trim()
  return {
    key,
    displayName,
    icdCode: input.icdCode?.trim() ? normalizeIcdCode(input.icdCode) : null,
    diagnosedAt: input.diagnosedAt,
    status: input.status,
    managingProviderId: input.managingProviderId,
    notes: input.notes,
  }
}

export function conditionDisplayLabel(row: {
  key: string
  displayName?: string | null
}): string {
  if (row.displayName?.trim()) return row.displayName.trim()
  if (CONDITION_KEYS.includes(row.key as ConditionKey)) {
    return CONDITION_LABELS[row.key as ConditionKey]
  }
  if (row.key.startsWith('icd:')) return row.key.slice(4)
  if (row.key.startsWith('custom:')) {
    return row.key
      .slice(7)
      .split('-')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ')
  }
  return row.key
}
