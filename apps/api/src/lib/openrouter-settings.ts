import { eq } from 'drizzle-orm'
import { config, openRouterConfigured as envOpenRouterConfigured } from '../config.js'
import { db, schema } from '../db/index.js'
import { decrypt, encrypt } from './crypto.js'

export type OpenRouterTaskClass = 'chat' | 'extract' | 'analyze' | 'vision' | 'tts' | 'stt'

export const DEFAULT_OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'
export const DEFAULT_MODELS = {
  chat: 'anthropic/claude-sonnet-4.5',
  extract: 'anthropic/claude-haiku-4.5',
  analyze: 'anthropic/claude-sonnet-4.5',
  vision: 'anthropic/claude-sonnet-4.5',
  tts: 'mistralai/voxtral-mini-tts-2603',
  stt: 'openai/whisper-large-v3',
} as const
export const DEFAULT_TTS_VOICE = 'en_paul_neutral'

/** OpenRouter never published these slugs; they 400 as "does not exist". */
const MISSING_TTS_MODELS = new Set([
  'openai/gpt-4o-mini-tts',
  'openai/gpt-4o-mini-tts-2025-12-15',
])

const LEGACY_OPENAI_TTS_VOICES = new Set([
  'alloy',
  'echo',
  'fable',
  'onyx',
  'nova',
  'shimmer',
  'coral',
  'verse',
  'ballad',
  'ash',
  'sage',
  'marin',
  'cedar',
])

export function canonicalizeTtsModel(model: string): string {
  const id = model.trim()
  if (!id || MISSING_TTS_MODELS.has(id)) return DEFAULT_MODELS.tts
  return id
}

export function canonicalizeTtsVoice(voice: string, requestedModel: string): string {
  const v = voice.trim() || DEFAULT_TTS_VOICE
  const model = canonicalizeTtsModel(requestedModel)
  if (model === DEFAULT_MODELS.tts && LEGACY_OPENAI_TTS_VOICES.has(v)) {
    return DEFAULT_TTS_VOICE
  }
  return v
}

export interface ResolvedOpenRouterSettings {
  apiKey: string | null
  baseUrl: string
  models: Record<OpenRouterTaskClass, string>
  ttsVoice: string
}

export interface OpenRouterSettingsView {
  configured: boolean
  keyHint: string | null
  keySource: 'user' | 'server' | null
  baseUrl: string
  modelChat: string
  modelExtract: string
  modelAnalyze: string
  modelVision: string
  modelTts: string
  modelStt: string
  ttsVoice: string
  userOverrides: {
    baseUrl: boolean
    modelChat: boolean
    modelExtract: boolean
    modelAnalyze: boolean
    modelVision: boolean
    modelTts: boolean
    modelStt: boolean
    ttsVoice: boolean
  }
}

type ProfileAiRow = {
  openrouterApiKeyEncrypted: string | null
  openrouterBaseUrl: string | null
  openrouterModelChat: string | null
  openrouterModelExtract: string | null
  openrouterModelAnalyze: string | null
  openrouterModelVision: string | null
  openrouterModelTts: string | null
  openrouterModelStt: string | null
  openrouterTtsVoice: string | null
}

export function openRouterKeyHint(key: string): string {
  const trimmed = key.trim()
  if (trimmed.length <= 4) return '••••'
  return `••••${trimmed.slice(-4)}`
}

function pickString(
  userValue: string | null | undefined,
  envValue: string | undefined,
  fallback: string,
): { value: string; source: 'user' | 'server' | 'default' } {
  const user = userValue?.trim()
  if (user) return { value: user, source: 'user' }
  const env = envValue?.trim()
  if (env) return { value: env, source: 'server' }
  return { value: fallback, source: 'default' }
}

async function loadProfileAiRow(userId: string): Promise<ProfileAiRow | null> {
  const [row] = await db
    .select({
      openrouterApiKeyEncrypted: schema.profiles.openrouterApiKeyEncrypted,
      openrouterBaseUrl: schema.profiles.openrouterBaseUrl,
      openrouterModelChat: schema.profiles.openrouterModelChat,
      openrouterModelExtract: schema.profiles.openrouterModelExtract,
      openrouterModelAnalyze: schema.profiles.openrouterModelAnalyze,
      openrouterModelVision: schema.profiles.openrouterModelVision,
      openrouterModelTts: schema.profiles.openrouterModelTts,
      openrouterModelStt: schema.profiles.openrouterModelStt,
      openrouterTtsVoice: schema.profiles.openrouterTtsVoice,
    })
    .from(schema.profiles)
    .where(eq(schema.profiles.userId, userId))
    .limit(1)
  return row ?? null
}

function resolveApiKey(row: ProfileAiRow | null): { key: string | null; source: 'user' | 'server' | null } {
  if (row?.openrouterApiKeyEncrypted) {
    try {
      const key = decrypt(row.openrouterApiKeyEncrypted).trim()
      if (key) return { key, source: 'user' }
    } catch {
      /* corrupted ciphertext */
    }
  }
  const envKey = config.OPENROUTER_API_KEY?.trim()
  if (envKey) return { key: envKey, source: 'server' }
  return { key: null, source: null }
}

/** Resolved settings for API calls — user → env → default fallback chain. */
export async function getOpenRouterSettings(userId: string): Promise<ResolvedOpenRouterSettings> {
  const row = await loadProfileAiRow(userId)
  const { key } = resolveApiKey(row)

  const baseUrl = pickString(row?.openrouterBaseUrl, config.OPENROUTER_BASE_URL, DEFAULT_OPENROUTER_BASE_URL)
  const chat = pickString(row?.openrouterModelChat, config.MODEL_CHAT, DEFAULT_MODELS.chat)
  const extract = pickString(row?.openrouterModelExtract, config.MODEL_EXTRACT, DEFAULT_MODELS.extract)
  const analyze = pickString(row?.openrouterModelAnalyze, config.MODEL_ANALYZE, DEFAULT_MODELS.analyze)
  const vision = pickString(row?.openrouterModelVision, config.MODEL_VISION, DEFAULT_MODELS.vision)
  const ttsRaw = pickString(row?.openrouterModelTts, config.MODEL_TTS, DEFAULT_MODELS.tts).value
  const stt = pickString(row?.openrouterModelStt, config.MODEL_STT, DEFAULT_MODELS.stt)
  const ttsVoiceRaw = pickString(row?.openrouterTtsVoice, config.TTS_VOICE, DEFAULT_TTS_VOICE).value
  const tts = canonicalizeTtsModel(ttsRaw)
  const ttsVoice = canonicalizeTtsVoice(ttsVoiceRaw, ttsRaw)

  return {
    apiKey: key,
    baseUrl: baseUrl.value,
    models: {
      chat: chat.value,
      extract: extract.value,
      analyze: analyze.value,
      vision: vision.value,
      tts,
      stt: stt.value,
    },
    ttsVoice,
  }
}

export async function isOpenRouterConfigured(userId: string): Promise<boolean> {
  return (await getOpenRouterSettings(userId)).apiKey !== null
}

/** Safe view for Settings UI — never returns the full API key. */
export async function getOpenRouterSettingsView(userId: string): Promise<OpenRouterSettingsView> {
  const row = await loadProfileAiRow(userId)
  const { key, source } = resolveApiKey(row)
  const settings = await getOpenRouterSettings(userId)

  return {
    configured: key !== null,
    keyHint: key ? openRouterKeyHint(key) : null,
    keySource: source,
    baseUrl: settings.baseUrl,
    modelChat: settings.models.chat,
    modelExtract: settings.models.extract,
    modelAnalyze: settings.models.analyze,
    modelVision: settings.models.vision,
    modelTts: settings.models.tts,
    modelStt: settings.models.stt,
    ttsVoice: settings.ttsVoice,
    userOverrides: {
      baseUrl: Boolean(row?.openrouterBaseUrl?.trim()),
      modelChat: Boolean(row?.openrouterModelChat?.trim()),
      modelExtract: Boolean(row?.openrouterModelExtract?.trim()),
      modelAnalyze: Boolean(row?.openrouterModelAnalyze?.trim()),
      modelVision: Boolean(row?.openrouterModelVision?.trim()),
      modelTts: Boolean(row?.openrouterModelTts?.trim()),
      modelStt: Boolean(row?.openrouterModelStt?.trim()),
      ttsVoice: Boolean(row?.openrouterTtsVoice?.trim()),
    },
  }
}

export interface SaveOpenRouterSettingsInput {
  apiKey?: string
  baseUrl?: string | null
  modelChat?: string | null
  modelExtract?: string | null
  modelAnalyze?: string | null
  modelVision?: string | null
  modelTts?: string | null
  modelStt?: string | null
  ttsVoice?: string | null
}

function nullableTrim(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? ''
  return trimmed.length > 0 ? trimmed : null
}

export async function saveOpenRouterSettings(
  userId: string,
  input: SaveOpenRouterSettingsInput,
): Promise<void> {
  const set: Record<string, unknown> = { updatedAt: new Date() }

  if (input.apiKey !== undefined) {
    const trimmed = input.apiKey.trim()
    set.openrouterApiKeyEncrypted = encrypt(trimmed)
    set.openrouterConfiguredAt = new Date()
  }

  if (input.baseUrl !== undefined) set.openrouterBaseUrl = nullableTrim(input.baseUrl)
  if (input.modelChat !== undefined) set.openrouterModelChat = nullableTrim(input.modelChat)
  if (input.modelExtract !== undefined) set.openrouterModelExtract = nullableTrim(input.modelExtract)
  if (input.modelAnalyze !== undefined) set.openrouterModelAnalyze = nullableTrim(input.modelAnalyze)
  if (input.modelVision !== undefined) set.openrouterModelVision = nullableTrim(input.modelVision)
  if (input.modelTts !== undefined) set.openrouterModelTts = nullableTrim(input.modelTts)
  if (input.modelStt !== undefined) set.openrouterModelStt = nullableTrim(input.modelStt)
  if (input.ttsVoice !== undefined) set.openrouterTtsVoice = nullableTrim(input.ttsVoice)

  await db.update(schema.profiles).set(set).where(eq(schema.profiles.userId, userId))
}

export async function clearOpenRouterApiKey(userId: string): Promise<void> {
  await db
    .update(schema.profiles)
    .set({
      openrouterApiKeyEncrypted: null,
      openrouterConfiguredAt: null,
      updatedAt: new Date(),
    })
    .where(eq(schema.profiles.userId, userId))
}

/** True when any server-wide env key is set (health / admin). */
export { envOpenRouterConfigured as serverOpenRouterConfigured }

// Back-compat aliases used during refactor
export const getOpenRouterIntegration = getOpenRouterSettingsView
export const saveOpenRouterApiKey = (userId: string, apiKey: string) =>
  saveOpenRouterSettings(userId, { apiKey })
