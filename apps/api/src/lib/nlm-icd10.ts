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

const STOP_WORDS = new Set(['the', 'and', 'with', 'for', 'of'])

/** Prefer unspecified / without-complications codes over the first subtype hit. */
export function pickBestIcdMatch(query: string, entries: NlmIcdEntry[]): NlmIcdEntry | null {
  if (entries.length === 0) return null
  const q = query.trim().toLowerCase().replace(/[.,]/g, ' ').replace(/\s+/g, ' ')
  const words = q.split(' ').filter((w) => w.length > 2 && !STOP_WORDS.has(w))

  let best: { entry: NlmIcdEntry; score: number } | null = null
  for (const entry of entries) {
    const name = entry.name.toLowerCase()
    let score = 0
    if (name === q) score += 100
    if (entry.code.toLowerCase() === q.replace(/\s/g, '')) score += 100
    if (name.startsWith(q)) score += 35
    if (name.includes(q)) score += 20
    if (words.length > 0 && words.every((w) => name.includes(w))) score += 15
    if (/\bunspecified\b/.test(name)) score += 12
    if (/without complications/.test(name)) score += 12
    if (/\buncomplicated\b/.test(name)) score += 8
    if (/\bwith\b/.test(name) && !/without/.test(name)) score -= 10
    if (!best || score > best.score) best = { entry, score }
  }
  if (!best || best.score < 25) return null
  return best.entry
}
