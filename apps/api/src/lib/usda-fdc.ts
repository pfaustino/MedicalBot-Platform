import { dataTypeRank, parseUsdaFood, type FoodNutrition } from '@medbot/shared'
import { config } from '../config.js'

const FDC_BASE = 'https://api.nal.usda.gov/fdc/v1'
const SEARCH_TTL_MS = 10 * 60 * 1000
const FOOD_TTL_MS = 24 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 8000
const CACHE_CAP = 200

export interface FoodSearchHit {
  fdcId: number
  name: string
  brand: string | null
  dataType: string
}

interface CacheEntry<T> {
  value: T
  fetchedAt: number
}

const searchCache = new Map<string, CacheEntry<FoodSearchHit[]>>()
const foodCache = new Map<string, CacheEntry<FoodNutrition | null>>()

export async function searchUsdaFoods(query: string, limit = 8): Promise<FoodSearchHit[]> {
  const q = query.trim()
  if (q.length < 2) return []

  const cacheKey = `${q.toLowerCase()}:${limit}`
  const cached = searchCache.get(cacheKey)
  if (cached && Date.now() - cached.fetchedAt < SEARCH_TTL_MS) return cached.value

  const url = new URL(`${FDC_BASE}/foods/search`)
  url.searchParams.set('api_key', config.USDA_FDC_API_KEY)
  url.searchParams.set('query', q)
  url.searchParams.set('pageSize', String(Math.min(Math.max(limit, 1), 25)))
  url.searchParams.set('dataType', 'Foundation,SR Legacy,Survey (FNDDS),Branded')

  const json = await fdcFetch(url)
  const foods = Array.isArray((json as { foods?: unknown }).foods)
    ? ((json as { foods: unknown[] }).foods)
    : []
  const hits: FoodSearchHit[] = []
  for (const item of foods) {
    const parsed = parseUsdaFood(item)
    if (!parsed) continue
    hits.push({
      fdcId: parsed.fdcId,
      name: parsed.name,
      brand: parsed.brand,
      dataType: parsed.dataType,
    })
  }
  hits.sort((a, b) => dataTypeRank(a.dataType) - dataTypeRank(b.dataType) || a.name.localeCompare(b.name))
  const sliced = hits.slice(0, limit)
  remember(searchCache, cacheKey, sliced)
  return sliced
}

export async function getUsdaFood(fdcId: number): Promise<FoodNutrition | null> {
  if (!Number.isInteger(fdcId) || fdcId <= 0) return null
  const cacheKey = String(fdcId)
  const cached = foodCache.get(cacheKey)
  if (cached && Date.now() - cached.fetchedAt < FOOD_TTL_MS) return cached.value

  const url = new URL(`${FDC_BASE}/food/${fdcId}`)
  url.searchParams.set('api_key', config.USDA_FDC_API_KEY)
  const json = await fdcFetch(url)
  const food = parseUsdaFood(json)
  remember(foodCache, cacheKey, food)
  return food
}

async function fdcFetch(url: URL): Promise<unknown> {
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
      throw new Error(`USDA FoodData Central returned ${response.status}`)
    }
    return await response.json()
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('USDA FoodData Central timed out')
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

function remember<T>(cache: Map<string, CacheEntry<T>>, key: string, value: T): void {
  cache.set(key, { value, fetchedAt: Date.now() })
  if (cache.size <= CACHE_CAP) return
  const oldest = cache.keys().next().value
  if (oldest != null) cache.delete(oldest)
}
