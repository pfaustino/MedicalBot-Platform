export interface SlimModel {
  id: string
  name: string
  contextLength?: number
}

interface CacheEntry {
  models: SlimModel[]
  fetchedAt: number
}

const CACHE_TTL_MS = 5 * 60 * 1000
const cache = new Map<string, CacheEntry>()

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/$/, '')
}

export async function fetchOpenRouterModels(apiKey: string, baseUrl: string): Promise<SlimModel[]> {
  const key = normalizeBaseUrl(baseUrl)
  const cached = cache.get(key)
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.models
  }

  const url = `${key}/models`
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
  })

  if (!response.ok) {
    const text = await response.text()
    throw new OpenRouterModelsError(
      `OpenRouter models request failed (${response.status})`,
      response.status,
      text.slice(0, 500),
    )
  }

  const json = (await response.json()) as {
    data?: Array<{ id?: string; name?: string; context_length?: number }>
  }

  const models: SlimModel[] = (json.data ?? [])
    .filter((m) => Boolean(m.id))
    .map((m) => ({
      id: m.id!,
      name: m.name?.trim() || m.id!,
      contextLength: m.context_length ?? undefined,
    }))
    .sort((a, b) => a.id.localeCompare(b.id))

  cache.set(key, { models, fetchedAt: Date.now() })
  return models
}

export function filterOpenRouterModels(models: SlimModel[], q: string, limit = 50): SlimModel[] {
  const query = q.trim().toLowerCase()
  if (!query) return models.slice(0, limit)
  return models
    .filter((m) => m.id.toLowerCase().includes(query) || m.name.toLowerCase().includes(query))
    .slice(0, limit)
}

export class OpenRouterModelsError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message)
    this.name = 'OpenRouterModelsError'
  }
}
