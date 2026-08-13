import { config } from '../config.js'

const MEDLINEPLUS_URL = 'https://connect.medlineplus.gov/service'
const ICD10_CM_OID = '2.16.840.1.113883.6.90'
/** NLM asks implementers to cache 12–24 hours and stay under 100 req/min. */
const CACHE_TTL_MS = 12 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 5000
const SUMMARY_CHARS = 700

export interface MedlinePlusTopic {
  title: string
  url: string
  summary: string
}

export interface MedlinePlusReference {
  found: boolean
  topics: MedlinePlusTopic[]
}

interface CacheEntry {
  value: MedlinePlusReference
  fetchedAt: number
}

const cache = new Map<string, CacheEntry>()

/**
 * MedlinePlus Connect — patient education for an ICD-10-CM code.
 * https://medlineplus.gov/medlineplus-connect/web-service/
 */
export async function lookupMedlinePlus(icdCode: string): Promise<MedlinePlusReference> {
  const code = icdCode.trim().toUpperCase()
  if (!code) return { found: false, topics: [] }

  const cached = cache.get(code)
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.value
  }

  const url = new URL(MEDLINEPLUS_URL)
  url.searchParams.set('mainSearchCriteria.v.cs', ICD10_CM_OID)
  url.searchParams.set('mainSearchCriteria.v.c', code)
  url.searchParams.set('informationRecipient.languageCode.c', 'en')
  url.searchParams.set('knowledgeResponseType', 'application/json')

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
    if (!response.ok) {
      throw new Error(`MedlinePlus Connect returned ${response.status}`)
    }
    const value = parseMedlinePlusResponse(await response.json())
    cache.set(code, { value, fetchedAt: Date.now() })
    return value
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('MedlinePlus Connect timed out')
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

function parseMedlinePlusResponse(json: unknown): MedlinePlusReference {
  const feed = (json as { feed?: { entry?: unknown } } | null)?.feed
  const raw = feed?.entry
  const entries = Array.isArray(raw) ? raw : raw ? [raw] : []
  const topics: MedlinePlusTopic[] = []

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue
    const rec = entry as Record<string, unknown>
    const title = textValue(rec.title)
    const url = firstHref(rec.link)
    const summary = excerpt(htmlToPlainText(textValue(rec.summary)))
    if (!title || !url) continue
    topics.push({ title, url, summary })
  }

  topics.sort((a, b) => topicRank(a.url) - topicRank(b.url))
  const sliced = topics.slice(0, 3)
  return { found: sliced.length > 0, topics: sliced }
}

function topicRank(url: string): number {
  if (url.includes('medlineplus.gov/genetics')) return 2
  if (url.includes('medlineplus.gov')) return 0
  return 1
}

function textValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object' && '_value' in value) {
    return String((value as { _value?: unknown })._value ?? '')
  }
  return ''
}

function firstHref(link: unknown): string {
  const items = Array.isArray(link) ? link : link ? [link] : []
  for (const item of items) {
    if (item && typeof item === 'object' && 'href' in item) {
      const href = String((item as { href?: unknown }).href ?? '').trim()
      if (href.startsWith('https://')) return href
    }
  }
  return ''
}

function htmlToPlainText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

function excerpt(text: string): string {
  if (text.length <= SUMMARY_CHARS) return text
  const sliced = text.slice(0, SUMMARY_CHARS)
  const lastStop = Math.max(sliced.lastIndexOf('. '), sliced.lastIndexOf('? '), sliced.lastIndexOf('! '))
  if (lastStop >= 200) return sliced.slice(0, lastStop + 1)
  return `${sliced.trim()}…`
}
