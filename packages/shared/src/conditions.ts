import { z } from 'zod'
import { METRIC_TYPES } from './metrics.js'
import { CONDITION_KEYS, CONDITION_LABELS, type ConditionKey } from './profile.js'
import { ICD_CONDITION_CATALOG } from './reference/icd-conditions.js'
import { CONDITION_ICD10 } from './reference/condition-icd10.js'

/** Persistable subset of a ConditionModule — stored on conditions.module_config. */
export const storedTrackedMetricSchema = z.object({
  type: z.enum(METRIC_TYPES),
  dailyPrompts: z.number().int().min(0).max(24),
  targetMin: z.number().nullable(),
  targetMax: z.number().nullable(),
  contexts: z.array(z.string()).optional(),
})

export const storedRedFlagSchema = z.object({
  id: z.string().min(1).max(80),
  metric: z.enum(METRIC_TYPES),
  context: z.string().max(120).optional(),
  operator: z.enum(['lt', 'gt']),
  threshold: z.number(),
  occurrences: z.number().int().min(1),
  windowHours: z.number().int().min(1),
  severity: z.enum(['notice', 'urgent', 'emergency']),
  message: z.string().min(1).max(500),
})

export const storedTrendEvalSchema = z.object({
  metric: z.enum(METRIC_TYPES),
  context: z.string().max(120).optional(),
  kind: z.enum(['avg_vs_prior', 'rise_in_window', 'avg_above', 'latest_vs_earliest']),
  windowDays: z.number().int().min(1).max(365),
  priorDays: z.number().int().min(1).max(365).optional(),
  threshold: z.number(),
  direction: z.enum(['up', 'down']).optional(),
})

export const storedTrendRuleSchema = z.object({
  id: z.string().min(1).max(80),
  description: z.string().min(1).max(200),
  detect: z.string().min(1).max(500),
  eval: storedTrendEvalSchema.optional(),
})

export const storedModuleConfigSchema = z.object({
  label: z.string().min(1).max(200).optional(),
  summary: z.string().min(1).max(1000),
  metrics: z.array(storedTrackedMetricSchema).min(1).max(20),
  questionnaireKeys: z.array(z.string()).max(20).optional(),
  redFlags: z.array(storedRedFlagSchema).max(20).optional(),
  trends: z.array(storedTrendRuleSchema).max(20).optional(),
  promptGuidance: z.string().max(4000).optional(),
})

export type StoredModuleConfig = z.infer<typeof storedModuleConfigSchema>

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

/** Rebuild a dotted ICD-10-CM code from a stored `icd:E119` key. */
export function icdCodeFromConditionKey(key: string): string | null {
  if (!key.startsWith('icd:')) return null
  const raw = key.slice(4).toUpperCase().replace(/[^A-Z0-9.]/g, '')
  if (!raw) return null
  if (raw.includes('.')) return raw
  if (raw.length <= 3) return raw
  return `${raw.slice(0, 3)}.${raw.slice(3)}`
}

/**
 * ICD prefixes that map to a built-in module key. Used when a free-text or
 * imported diagnosis carries a code but no explicit moduleKey.
 */
const ICD_MODULE_PREFIXES: Array<{ prefix: string; key: ConditionKey }> = [
  { prefix: 'E10', key: 'diabetes_t1' },
  { prefix: 'E11', key: 'diabetes_t2' },
  { prefix: 'R7303', key: 'prediabetes' },
  { prefix: 'N18', key: 'ckd' },
  { prefix: 'F41', key: 'anxiety' },
  { prefix: 'F32', key: 'depression' },
  { prefix: 'F33', key: 'depression' },
  { prefix: 'I10', key: 'hypertension' },
  { prefix: 'J44', key: 'copd' },
  { prefix: 'J45', key: 'asthma' },
]

/**
 * Resolve which condition module (if any) a stored row or create payload should
 * use. Matching order: explicit moduleKey → enum key → ICD prefix → label /
 * slug name match. Custom keys like `custom:anxiety` still resolve to `anxiety`
 * when the display name matches.
 */
export function inferModuleKey(input: {
  key?: string | null
  name?: string | null
  displayName?: string | null
  moduleKey?: string | null
  icdCode?: string | null
}): ConditionKey | null {
  if (input.moduleKey && CONDITION_KEYS.includes(input.moduleKey as ConditionKey)) {
    return input.moduleKey as ConditionKey
  }
  if (input.key && CONDITION_KEYS.includes(input.key as ConditionKey)) {
    return input.key as ConditionKey
  }

  const code = input.icdCode?.trim()
    ? normalizeIcdCode(input.icdCode).replace(/\./g, '')
    : input.key?.startsWith('icd:')
      ? input.key.slice(4).toUpperCase()
      : null
  if (code) {
    for (const { prefix, key } of ICD_MODULE_PREFIXES) {
      if (code.startsWith(prefix)) return key
    }
  }

  const rawName = (input.displayName ?? input.name ?? '').trim().toLowerCase()
  const slug =
    input.key?.startsWith('custom:') ? input.key.slice(7) : rawName ? slugify(rawName) : ''
  const candidates = [rawName, slug.replace(/-/g, ' '), slug].filter(Boolean)

  for (const key of CONDITION_KEYS) {
    const label = CONDITION_LABELS[key].toLowerCase()
    const keyWords = key.replace(/_/g, ' ')
    for (const c of candidates) {
      if (!c) continue
      if (c === key || c === label || slugify(c) === key || slugify(c) === slugify(label)) {
        return key
      }
      // Name contains the full label or key phrase ("Chronic kidney disease, stage 4" → ckd)
      if (c.includes(label) || c.includes(keyWords)) {
        return key
      }
    }
  }

  return null
}

export function buildConditionKey(input: {
  name: string
  moduleKey?: string | null
  icdCode?: string | null
}): string {
  const inferred = inferModuleKey(input)
  if (inferred) return inferred
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
      const moduleKey = inferModuleKey({ name: entry.name, icdCode: code })
      add({
        key: buildConditionKey({ name: entry.name, moduleKey, icdCode: code }),
        name: entry.name,
        icdCode: entry.code,
        moduleKey,
        hasModule: false,
        source: 'icd',
      })
    }
  }

  if (q.length >= 2) {
    const moduleKey = inferModuleKey({ name: query.trim() })
    add({
      key: buildConditionKey({ name: query.trim(), moduleKey }),
      name: query.trim(),
      icdCode: null,
      moduleKey,
      hasModule: false,
      source: moduleKey ? 'module' : 'custom',
    })
  }

  return results.slice(0, limit)
}

export function conditionSearchFromIcd(code: string, name: string): ConditionSearchResult {
  const normalized = normalizeIcdCode(code)
  const moduleKey = inferModuleKey({ name, icdCode: normalized })
  return {
    key: buildConditionKey({ name, moduleKey, icdCode: normalized }),
    name,
    icdCode: code.trim(),
    moduleKey,
    hasModule: false,
    source: 'icd',
  }
}

/** Prefer NIH ICD-10-CM hits over the local starter list; keep modules and custom. */
export function mergeConditionSearchWithNlm(
  local: ConditionSearchResult[],
  nlm: Array<{ code: string; name: string }>,
  limit: number,
): ConditionSearchResult[] {
  if (nlm.length === 0) return local.slice(0, limit)

  const results: ConditionSearchResult[] = []
  const seen = new Set<string>()
  const add = (r: ConditionSearchResult) => {
    if (seen.has(r.key)) return
    seen.add(r.key)
    results.push(r)
  }

  for (const r of local) {
    if (r.source === 'module') add(r)
  }
  for (const entry of nlm) {
    add(conditionSearchFromIcd(entry.code, entry.name))
  }
  for (const r of local) {
    if (r.source === 'custom') add(r)
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

export const conditionRenameSchema = z.object({
  name: z.string().min(1).max(200),
  moduleKey: z.enum(CONDITION_KEYS).nullish(),
  icdCode: z.string().max(20).nullish(),
})

export type ConditionRenameInput = z.infer<typeof conditionRenameSchema>

export function resolveConditionCreate(input: ConditionCreateInput) {
  const moduleKey = inferModuleKey({
    name: input.name,
    moduleKey: input.moduleKey,
    icdCode: input.icdCode,
  })
  const key = buildConditionKey({
    name: input.name,
    moduleKey: moduleKey ?? input.moduleKey,
    icdCode: input.icdCode,
  })
  const pickedIcd = input.icdCode?.trim() ? normalizeIcdCode(input.icdCode) : null
  const canon = moduleKey ? CONDITION_ICD10[moduleKey] : undefined
  const icdCode = pickedIcd ?? canon?.code ?? null
  const displayName = pickedIcd
    ? input.name.trim()
    : (canon?.name ??
      (moduleKey && CONDITION_LABELS[moduleKey] ? CONDITION_LABELS[moduleKey] : input.name.trim()))
  return {
    key,
    displayName,
    icdCode,
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
