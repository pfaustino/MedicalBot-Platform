import {
  CONDITION_ICD10,
  CONDITION_LABELS,
  ICD_CONDITION_CATALOG,
  conditionDisplayLabel,
  icdCodeFromConditionKey,
  inferModuleKey,
  normalizeIcdCode,
} from '@medbot/shared'
import { pickBestIcdMatch, searchNlmIcd10, type NlmIcdEntry } from './nlm-icd10.js'

export interface AlignedIcd {
  icdCode: string
  displayName: string
}

export async function resolveIcdForCondition(row: {
  key: string
  displayName?: string | null
  icdCode?: string | null
}): Promise<AlignedIcd | null> {
  const existing = row.icdCode?.trim()
  if (existing) {
    const code = normalizeIcdCode(existing)
    if (row.displayName?.trim()) {
      return { icdCode: code, displayName: row.displayName.trim() }
    }
    const named = await nameForCode(code)
    return { icdCode: code, displayName: named ?? code }
  }

  const label = (row.displayName?.trim() || conditionDisplayLabel({ key: row.key.trim(), displayName: row.displayName })).trim()
  const moduleKey = inferModuleKey({
    key: row.key.trim(),
    name: label,
    displayName: label,
    icdCode: row.icdCode,
  })
  if (moduleKey) {
    const canon = CONDITION_ICD10[moduleKey]
    return { icdCode: canon.code, displayName: canon.name }
  }

  const fromKey = icdCodeFromConditionKey(row.key.trim())
  if (fromKey) {
    const named = await nameForCode(fromKey)
    return { icdCode: fromKey, displayName: named ?? fromKey }
  }

  if (label.length < 2) return null

  for (const query of queriesFor(label)) {
    const local = pickBestIcdMatch(query, ICD_CONDITION_CATALOG)
    if (local) return { icdCode: local.code, displayName: local.name }
  }

  for (const query of queriesFor(label)) {
    const entries = await searchNlmIcd10(query, 25)
    let pick = pickBestIcdMatch(query, entries)
    if (!pick || !/unspecified|without complications|uncomplicated/.test(pick.name.toLowerCase())) {
      const extra = await searchNlmIcd10(`${query} unspecified`, 10)
      pick = pickBestIcdMatch(query, [...extra, ...entries]) ?? pick
    }
    if (!pick && entries[0] && nameCoversQuery(entries[0], query)) pick = entries[0]
    if (pick) return { icdCode: pick.code, displayName: pick.name }
  }

  return null
}

function queriesFor(label: string): string[] {
  const q = label.trim()
  const extra: string[] = []
  const lower = q.toLowerCase()
  if (/blood pressure/.test(lower)) extra.push('hypertension', 'Essential (primary) hypertension')
  if (/cholesterol/.test(lower)) extra.push('hyperlipidemia')
  if (/weight management|obesity/.test(lower)) extra.push('obesity')
  if (/\bcopd\b/.test(lower)) extra.push('chronic obstructive pulmonary disease')
  for (const [key, friendly] of Object.entries(CONDITION_LABELS)) {
    if (lower === friendly.toLowerCase() || lower.includes(friendly.toLowerCase())) {
      extra.push(CONDITION_ICD10[key as keyof typeof CONDITION_ICD10].name)
    }
  }
  return [...new Set([q, ...extra])].filter((s) => s.length >= 2)
}

function nameCoversQuery(entry: NlmIcdEntry, query: string): boolean {
  const name = entry.name.toLowerCase()
  const words = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2)
  return words.length > 0 && words.every((w) => name.includes(w))
}

async function nameForCode(code: string): Promise<string | null> {
  const entries = await searchNlmIcd10(code, 5)
  const hit = entries.find((e) => normalizeIcdCode(e.code) === normalizeIcdCode(code))
  return hit?.name ?? null
}
