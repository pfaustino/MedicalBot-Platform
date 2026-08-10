import { config } from '../config.js'
import { getOpenRouterSettings } from '../lib/openrouter-settings.js'

/**
 * Thin OpenRouter client. Deliberately not the OpenAI SDK — we need the
 * `models` fallback array and OpenRouter's ranking headers, and the surface we
 * use is small enough that a fetch wrapper is less code than adapting a SDK.
 */

export type TaskClass = 'chat' | 'extract' | 'analyze' | 'vision'

/**
 * Multimodal content parts. A message's content is either plain text or an array
 * of parts — text plus an image (data URL) or a PDF `file` part, which is how the
 * document parser hands scans and reports to a vision-capable model.
 */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  | { type: 'file'; file: { filename: string; file_data: string } }

export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | ContentPart[]
  /** Present on assistant turns that requested tools; echoed back next round. */
  tool_calls?: ToolCall[]
  /** Present on tool-result turns, linking back to the call. */
  tool_call_id?: string
  name?: string
}

export interface CompletionOptions {
  task: TaskClass
  messages: ChatMessage[]
  /** Resolves per-user OpenRouter settings (key, base URL, models). */
  userId: string
  tools?: unknown[]
  /** Ordered fallbacks. OpenRouter tries the next on provider failure. */
  fallbackModels?: string[]
  temperature?: number
  maxTokens?: number
  /** Forces the model to emit JSON matching this schema. Used by extraction. */
  jsonSchema?: { name: string; schema: Record<string, unknown> }
  signal?: AbortSignal
}

export interface CompletionResult {
  content: string
  model: string
  toolCalls: ToolCall[]
  usage: { promptTokens: number; completionTokens: number } | null
}

export class OpenRouterError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message)
    this.name = 'OpenRouterError'
  }
}

/**
 * Plain-language explanation of an OpenRouter failure, so the UI can tell the
 * user what to actually fix instead of a generic "couldn't respond".
 */
export function describeOpenRouterError(err: OpenRouterError): string {
  const snippet = err.body ? ` (${err.body.slice(0, 200)})` : ''
  switch (err.status) {
    case 401:
      return 'Invalid OpenRouter API key. Check your key in Settings → AI & OpenRouter.'
    case 402:
      return 'Your OpenRouter account is out of credits. Add credits at openrouter.ai/credits.'
    case 403:
      return `OpenRouter denied the request — the key may not have access to this model.${snippet}`
    case 404:
      return `The configured model was not found on OpenRouter. Check your model settings in Settings.${snippet}`
    case 429:
      return 'OpenRouter rate-limited the request. Wait a moment and try again.'
    default:
      return `OpenRouter error ${err.status}.${snippet}`
  }
}

/** Safe, user-facing message for OpenRouter and related AI failures (import, etc.). */
export function openRouterUserMessage(err: unknown): string | null {
  if (err instanceof OpenRouterError) {
    if (err.status === 400) {
      try {
        const parsed = JSON.parse(err.body) as { error?: { message?: string } }
        const msg = parsed.error?.message
        if (msg) {
          return `Vision model error: ${msg}. Pick a vision-capable model in Settings → AI & OpenRouter.`
        }
      } catch {
        /* ignore malformed body */
      }
      return 'OpenRouter rejected the request. Check your vision model in Settings → AI & OpenRouter.'
    }
    return describeOpenRouterError(err)
  }
  if (err instanceof Error) {
    if (err.message === 'Model did not return valid JSON') {
      return 'The AI could not parse this document. Try a clearer scan or a different file.'
    }
    if (err.message === 'OpenRouter API key is not configured') {
      return 'Add your OpenRouter API key in Settings to enable document import.'
    }
  }
  return null
}

export async function complete(options: CompletionOptions): Promise<CompletionResult> {
  const settings = await getOpenRouterSettings(options.userId)
  if (!settings.apiKey) {
    throw new OpenRouterError('OpenRouter API key is not configured', 500, '')
  }

  const model = settings.models[options.task]

  const body: Record<string, unknown> = {
    model,
    messages: options.messages,
    temperature: options.temperature ?? (options.task === 'chat' ? 0.7 : 0),
    max_tokens: options.maxTokens ?? 2048,
  }

  if (options.fallbackModels?.length) body.models = [model, ...options.fallbackModels]
  if (options.tools?.length) body.tools = options.tools
  if (options.jsonSchema) {
    body.response_format = {
      type: 'json_schema',
      json_schema: { ...options.jsonSchema, strict: true },
    }
  }

  const response = await fetch(`${settings.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${settings.apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': config.APP_URL,
      'X-Title': 'MedicalBot Platform',
    },
    body: JSON.stringify(body),
    signal: options.signal,
  })

  if (!response.ok) {
    const text = await response.text()
    throw new OpenRouterError(
      `OpenRouter returned ${response.status}`,
      response.status,
      text.slice(0, 500),
    )
  }

  const json = (await response.json()) as {
    model?: string
    choices?: Array<{ message?: { content?: string; tool_calls?: ToolCall[] } }>
    usage?: { prompt_tokens?: number; completion_tokens?: number }
  }

  const choice = json.choices?.[0]
  return {
    content: choice?.message?.content ?? '',
    model: json.model ?? model,
    toolCalls: choice?.message?.tool_calls ?? [],
    usage: json.usage
      ? {
          promptTokens: json.usage.prompt_tokens ?? 0,
          completionTokens: json.usage.completion_tokens ?? 0,
        }
      : null,
  }
}
