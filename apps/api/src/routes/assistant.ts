import type { FastifyInstance } from 'fastify'
import { asc, desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { isOpenRouterConfigured, getOpenRouterSettings } from '../lib/openrouter-settings.js'
import { db, schema } from '../db/index.js'
import { runAgent } from '../ai/agent.js'
import { synthesizeSpeech, transcribeAudio } from '../ai/openrouter-audio.js'
import {
  complete,
  describeOpenRouterError,
  OpenRouterError,
  type ChatMessage,
} from '../ai/openrouter.js'
import { requireAdmin, requireUser } from './auth.js'

const AUDIO_FORMATS = ['webm', 'wav', 'mp3', 'mpeg', 'ogg', 'm4a', 'mp4', 'flac', 'aac'] as const

function formatFromMime(mimeType: string): string | null {
  const raw = mimeType.toLowerCase().split(';')[0]?.trim() ?? ''
  if (raw === 'audio/webm') return 'webm'
  if (raw === 'audio/wav' || raw === 'audio/x-wav' || raw === 'audio/wave') return 'wav'
  if (raw === 'audio/mpeg' || raw === 'audio/mp3') return 'mp3'
  if (raw === 'audio/ogg' || raw === 'audio/opus') return 'ogg'
  if (raw === 'audio/mp4' || raw === 'audio/m4a' || raw === 'audio/x-m4a') return 'm4a'
  if (raw === 'audio/flac') return 'flac'
  if (raw === 'audio/aac') return 'aac'
  const subtype = raw.split('/')[1]
  if (subtype && (AUDIO_FORMATS as readonly string[]).includes(subtype)) return subtype
  return null
}

/**
 * Conversational assistant (SPEC §4). Each turn assembles context, runs the
 * tool-using agent, and persists both sides of the exchange so the thread
 * survives reloads. If OpenRouter is not configured the endpoint says so
 * plainly rather than failing cryptically.
 */
export async function assistantRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireUser)

  app.get('/assistant/history', async (request, reply) => {
    const userId = request.session.userId!
    const rows = await db
      .select({
        role: schema.conversations.role,
        content: schema.conversations.content,
        createdAt: schema.conversations.createdAt,
      })
      .from(schema.conversations)
      .where(eq(schema.conversations.userId, userId))
      .orderBy(asc(schema.conversations.createdAt))
      .limit(200)
    return reply.send({ messages: rows, configured: await isOpenRouterConfigured(userId) })
  })

  app.delete('/assistant/history', async (request, reply) => {
    const userId = request.session.userId!
    await db.delete(schema.conversations).where(eq(schema.conversations.userId, userId))
    return reply.send({ ok: true })
  })

  const chatBody = z.object({
    message: z.string().min(1).max(4000),
    personaId: z.string().max(60).default('maya'),
  })

  app.post('/assistant/chat', async (request, reply) => {
    const userId = request.session.userId!
    if (!(await isOpenRouterConfigured(userId))) {
      return reply.code(503).send({
        error: 'Add your OpenRouter API key in Settings to enable the assistant.',
        configured: false,
      })
    }

    const parsed = chatBody.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid message', issues: parsed.error.issues })
    }
    const { message, personaId } = parsed.data

    const recent = await db
      .select({ role: schema.conversations.role, content: schema.conversations.content })
      .from(schema.conversations)
      .where(eq(schema.conversations.userId, userId))
      .orderBy(desc(schema.conversations.createdAt))
      .limit(20)
    const history: ChatMessage[] = recent
      .reverse()
      .map((r) => ({ role: r.role as ChatMessage['role'], content: r.content }))

    try {
      const turn = await runAgent({ userId, personaId, history, message })

      await db.insert(schema.conversations).values([
        { userId, role: 'user', content: message },
        {
          userId,
          role: 'assistant',
          content: turn.reply,
          model: turn.model,
          toolCalls: turn.toolCalls.length ? turn.toolCalls : null,
        },
      ])

      return reply.send({ reply: turn.reply, actions: turn.actions, model: turn.model })
    } catch (err) {
      if (err instanceof OpenRouterError) {
        request.log.error({ status: err.status, body: err.body }, 'OpenRouter call failed')
        return reply.code(502).send({ error: describeOpenRouterError(err) })
      }
      request.log.error({ err: err instanceof Error ? err.message : 'unknown' }, 'Assistant turn failed')
      return reply.code(502).send({ error: 'The assistant had trouble responding. Please try again.' })
    }
  })

  const speechBody = z.object({
    text: z.string().min(1).max(4000),
    voice: z.string().max(60).optional(),
    model: z.string().max(200).optional(),
  })

  app.post('/assistant/speech', async (request, reply) => {
    const userId = request.session.userId!
    if (!(await isOpenRouterConfigured(userId))) {
      return reply.code(503).send({
        error: 'Add your OpenRouter API key in Settings to enable voice.',
        configured: false,
      })
    }

    const parsed = speechBody.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid speech request', issues: parsed.error.issues })
    }

    try {
      const audio = await synthesizeSpeech({
        userId,
        input: parsed.data.text,
        voice: parsed.data.voice,
        model: parsed.data.model,
      })
      return reply
        .header('Content-Type', audio.contentType)
        .header('X-Speech-Model', audio.model)
        .send(audio.bytes)
    } catch (err) {
      if (err instanceof OpenRouterError) {
        request.log.error({ status: err.status, body: err.body }, 'OpenRouter speech failed')
        return reply.code(502).send({ error: describeOpenRouterError(err) })
      }
      request.log.error({ err: err instanceof Error ? err.message : 'unknown' }, 'Speech failed')
      return reply.code(502).send({ error: 'Could not generate speech. Please try again.' })
    }
  })

  const transcribeBody = z.object({
    mimeType: z.string().min(1).max(120),
    dataUrl: z.string().min(1).max(12_000_000),
  })

  app.post(
    '/assistant/transcribe',
    { config: { bodyLimit: 10 * 1024 * 1024 } },
    async (request, reply) => {
      const userId = request.session.userId!
      if (!(await isOpenRouterConfigured(userId))) {
        return reply.code(503).send({
          error: 'Add your OpenRouter API key in Settings to enable voice.',
          configured: false,
        })
      }

      const parsed = transcribeBody.safeParse(request.body)
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid audio', issues: parsed.error.issues })
      }

      const format = formatFromMime(parsed.data.mimeType)
      if (!format) {
        return reply
          .code(400)
          .send({ error: 'Unsupported audio type. Try again from a modern browser.' })
      }

      const comma = parsed.data.dataUrl.indexOf(',')
      const rawB64 =
        parsed.data.dataUrl.startsWith('data:') && comma >= 0
          ? parsed.data.dataUrl.slice(comma + 1)
          : parsed.data.dataUrl
      if (!rawB64 || rawB64.length > 10_000_000) {
        return reply.code(400).send({ error: 'Audio recording is too large. Try a shorter clip.' })
      }

      try {
        const result = await transcribeAudio({
          userId,
          data: rawB64,
          format,
          language: 'en',
        })
        if (!result.text) {
          return reply.code(422).send({ error: 'Could not hear any speech. Try again.' })
        }
        return reply.send({ text: result.text, model: result.model })
      } catch (err) {
        if (err instanceof OpenRouterError) {
          request.log.error({ status: err.status, body: err.body }, 'OpenRouter STT failed')
          return reply.code(502).send({ error: describeOpenRouterError(err) })
        }
        request.log.error({ err: err instanceof Error ? err.message : 'unknown' }, 'Transcribe failed')
        return reply.code(502).send({ error: 'Could not transcribe audio. Please try again.' })
      }
    },
  )

  app.get('/assistant/diagnostics', { preHandler: requireAdmin }, async (request, reply) => {
    const userId = request.session.userId!
    if (!(await isOpenRouterConfigured(userId))) {
      return reply.send({
        configured: false,
        ok: false,
        message: 'Add your OpenRouter API key in Settings to enable the assistant.',
      })
    }
    const settings = await getOpenRouterSettings(userId)
    const chatModel = settings.models.chat
    try {
      const res = await complete({
        task: 'chat',
        userId,
        messages: [{ role: 'user', content: 'Reply with just: ok' }],
        maxTokens: 5,
        temperature: 0,
      })
      return reply.send({
        configured: true,
        ok: true,
        chatModel,
        respondedAs: res.model,
        sample: res.content.slice(0, 80),
      })
    } catch (err) {
      if (err instanceof OpenRouterError) {
        request.log.error({ status: err.status, body: err.body }, 'Assistant diagnostics failed')
        return reply.send({
          configured: true,
          ok: false,
          status: err.status,
          chatModel,
          message: describeOpenRouterError(err),
          detail: err.body?.slice(0, 300),
        })
      }
      return reply.send({
        configured: true,
        ok: false,
        chatModel,
        message: err instanceof Error ? err.message : 'unknown error',
      })
    }
  })
}
