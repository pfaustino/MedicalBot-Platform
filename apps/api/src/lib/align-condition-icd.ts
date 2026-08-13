import {
  CONDITION_ICD10,
  CONDITION_KEYS,
  conditionDisplayLabel,
  icdCodeFromConditionKey,
  normalizeIcdCode,
  type ConditionKey,
} from '@medbot/shared'
import { pickBestIcdMatch, searchNlmIcd10 } from './nlm-icd10.js'

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

  if (CONDITION_KEYS.includes(row.key as ConditionKey)) {
    const canon = CONDITION_ICD10[row.key as ConditionKey]
    return { icdCode: canon.code, displayName: canon.name }
  }

  const fromKey = icdCodeFromConditionKey(row.key)
  if (fromKey) {
    const named = await nameForCode(fromKey)
    return { icdCode: fromKey, displayName: named ?? fromKey }
  }

  const query = (row.displayName?.trim() || conditionDisplayLabel(row)).trim()
  if (query.length < 2) return null

  const entries = await searchNlmIcd10(query, 20)
  let pick = pickBestIcdMatch(query, entries)
  if (!pick || !/unspecified|without complications|uncomplicated/.test(pick.name.toLowerCase())) {
    const extra = await searchNlmIcd10(`${query} unspecified`, 10)
    pick = pickBestIcdMatch(query, [...extra, ...entries]) ?? pick
  }
  if (!pick) return null
  return { icdCode: pick.code, displayName: pick.name }
}

async function nameForCode(code: string): Promise<string | null> {
  const entries = await searchNlmIcd10(code, 5)
  const hit = entries.find((e) => normalizeIcdCode(e.code) === normalizeIcdCode(code))
  return hit?.name ?? null
}
