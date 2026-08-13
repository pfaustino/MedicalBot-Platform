import { config } from '../config.js'

const NLM_ICD10_URL = 'https://clinicaltables.nlm.nih.gov/api/icd10cm/v3/search'
const CACHE_TTL_MS = 10 * 60 * 1000
const FETCH_TIMEOUT_MS = 4000

interface CacheEntry {
  entries: NlmIcdEntry[]
  fetchedAt: number
}

const cache = new Map<string, CacheEntry>()

export interface NlmIcdEntry {
  code: string
  name: string
}

/**
 * NIH Clinical Table Search Service — ICD-10-CM (~75k codes, no API key).
 * https://clinicaltables.nlm.nih.gov/apidoc/icd10cm/v3/doc.html
 */
export async function searchNlmIcd10(query: string, limit = 20): Promise<NlmIcdEntry[]> {
  const q = query.trim()
  if (q.length < 2) return []

  const cacheKey = `${q.toLowerCase()}:${limit}`
  const cached = cache.get(cacheKey)
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.entries
  }

  const url = new URL(NLM_ICD10_URL)
  url.searchParams.set('terms', q)
  url.searchParams.set('sf', 'code,name')
  url.searchParams.set('df', 'code,name')
  url.searchParams.set('count', String(Math.min(Math.max(limit, 1), 50)))

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': `MedicalBot-Platform/1.0 (${config.APP_URL})`,
      },
    })
    if (!response.ok) return []
    const entries = parseNlmResponse(await response.json()).slice(0, limit)
    cache.set(cacheKey, { entries, fetchedAt: Date.now() })
    return entries
  } catch {
    return []
  } finally {
    clearTimeout(timer)
  }
}

/** NLM returns `[total, codes, extra, [[code, name], ...]]`. */
function parseNlmResponse(json: unknown): NlmIcdEntry[] {
  if (!Array.isArray(json) || json.length < 4 || !Array.isArray(json[3])) return []
  const entries: NlmIcdEntry[] = []
  for (const row of json[3] as unknown[]) {
    if (!Array.isArray(row) || row.length < 2) continue
    const code = String(row[0] ?? '').trim()
    const name = String(row[1] ?? '').trim()
    if (code && name) entries.push({ code, name })
  }
  return entries
}
