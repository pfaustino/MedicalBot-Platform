export interface SlimModel {
  id: string
  name: string
  contextLength?: number
  inputModalities: string[]
  outputModalities: string[]
}

export type ModelKind = 'text' | 'speech' | 'transcription'

interface CacheEntry {
  models: SlimModel[]
  fetchedAt: number
}

const CACHE_TTL_MS = 5 * 60 * 1000
const cache = new Map<string, CacheEntry>()

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/$/, '')
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === 'string' && v.length > 0)
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
    data?: Array<{
      id?: string
      name?: string
      context_length?: number
      architecture?: {
        input_modalities?: unknown
        output_modalities?: unknown
        modality?: string
      }
    }>
  }

  const models: SlimModel[] = (json.data ?? [])
    .filter((m) => Boolean(m.id))
    .map((m) => {
      const inputModalities = asStringArray(m.architecture?.input_modalities)
      const outputModalities = asStringArray(m.architecture?.output_modalities)
      return {
        id: m.id!,
        name: m.name?.trim() || m.id!,
        contextLength: m.context_length ?? undefined,
        inputModalities,
        outputModalities,
      }
    })
    .sort((a, b) => a.id.localeCompare(b.id))

  cache.set(key, { models, fetchedAt: Date.now() })
  return models
}

function matchesKind(model: SlimModel, kind: ModelKind): boolean {
  const id = model.id.toLowerCase()
  const outputs = model.outputModalities.map((m) => m.toLowerCase())
  const inputs = model.inputModalities.map((m) => m.toLowerCase())

  if (kind === 'speech') {
    if (outputs.includes('audio')) return true
    return /tts|speech/.test(id) && !/whisper|transcri/.test(id)
  }

  if (kind === 'transcription') {
    if (outputs.includes('transcription')) return true
    if (inputs.includes('audio') && outputs.includes('text') && /whisper|transcri|asr/.test(id)) {
      return true
    }
    return /whisper|transcri/.test(id)
  }

  // text: chat / extract / analyze / vision — exclude audio-only and STT-only
  if (outputs.includes('audio') && !outputs.includes('text')) return false
  if (outputs.includes('transcription') && !outputs.includes('text')) return false
  if (/whisper|transcri/.test(id)) return false
  if (outputs.length === 0) return true
  return outputs.includes('text')
}

export function filterOpenRouterModels(
  models: SlimModel[],
  q: string,
  kind: ModelKind = 'text',
  limit = 80,
): SlimModel[] {
  const scoped = models.filter((m) => matchesKind(m, kind))
  const query = q.trim().toLowerCase()
  if (!query) return scoped.slice(0, limit)
  return scoped
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
