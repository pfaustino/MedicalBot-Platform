import { config } from '../config.js'
import { getOpenRouterSettings } from '../lib/openrouter-settings.js'
import { OpenRouterError } from './openrouter.js'

/** Defaults for OpenRouter audio endpoints (override via env). */
export const DEFAULT_TTS_MODEL = 'openai/gpt-4o-mini-tts'
export const DEFAULT_STT_MODEL = 'openai/whisper-large-v3'
export const DEFAULT_TTS_VOICE = 'alloy'

function audioHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': config.APP_URL,
    'X-Title': 'MedicalBot Platform',
  }
}

async function requireKey(userId: string): Promise<{ apiKey: string; baseUrl: string }> {
  const settings = await getOpenRouterSettings(userId)
  if (!settings.apiKey) {
    throw new OpenRouterError('OpenRouter API key is not configured', 500, '')
  }
  return { apiKey: settings.apiKey, baseUrl: settings.baseUrl }
}

/** Text → spoken audio (raw bytes). Uses the same OpenRouter key as chat. */
export async function synthesizeSpeech(options: {
  userId: string
  input: string
  voice?: string
  responseFormat?: 'mp3' | 'pcm'
}): Promise<{ bytes: Buffer; contentType: string; model: string }> {
  const { apiKey, baseUrl } = await requireKey(options.userId)
  const model = config.MODEL_TTS
  const voice = options.voice?.trim() || config.TTS_VOICE
  const responseFormat = options.responseFormat ?? 'mp3'

  const response = await fetch(`${baseUrl}/audio/speech`, {
    method: 'POST',
    headers: audioHeaders(apiKey),
    body: JSON.stringify({
      model,
      input: options.input,
      voice,
      response_format: responseFormat,
    }),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new OpenRouterError(
      `OpenRouter speech returned ${response.status}`,
      response.status,
      text.slice(0, 500),
    )
  }

  const arrayBuffer = await response.arrayBuffer()
  return {
    bytes: Buffer.from(arrayBuffer),
    contentType: responseFormat === 'mp3' ? 'audio/mpeg' : 'audio/pcm',
    model,
  }
}

/** Mic/audio → transcript text. Uses the same OpenRouter key as chat. */
export async function transcribeAudio(options: {
  userId: string
  /** Raw base64 (no data: prefix). */
  data: string
  format: string
  language?: string
}): Promise<{ text: string; model: string }> {
  const { apiKey, baseUrl } = await requireKey(options.userId)
  const model = config.MODEL_STT

  const body: Record<string, unknown> = {
    model,
    input_audio: {
      data: options.data,
      format: options.format,
    },
  }
  if (options.language) body.language = options.language

  const response = await fetch(`${baseUrl}/audio/transcriptions`, {
    method: 'POST',
    headers: audioHeaders(apiKey),
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new OpenRouterError(
      `OpenRouter transcription returned ${response.status}`,
      response.status,
      text.slice(0, 500),
    )
  }

  const json = (await response.json()) as { text?: string }
  return { text: (json.text ?? '').trim(), model }
}
