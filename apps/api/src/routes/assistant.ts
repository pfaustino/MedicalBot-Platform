import type { FastifyInstance } from 'fastify'
import { asc, desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { isOpenRouterConfigured, getOpenRouterSettings } from '../lib/openrouter-settings.js'
import { db, schema } from '../db/index.js'
import { runAgent } from '../ai/agent.js'
import {
  complete,
  describeOpenRouterError,
  OpenRouterError,
  type ChatMessage,
} from '../ai/openrouter.js'
import { requireAdmin, requireUser } from './auth.js'

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

    // Recent turns for continuity (most recent 20, back into chronological order).
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
        // Log the full provider response, and tell the user what to actually fix.
        request.log.error({ status: err.status, body: err.body }, 'OpenRouter call failed')
        return reply.code(502).send({ error: describeOpenRouterError(err) })
      }
      request.log.error({ err: err instanceof Error ? err.message : 'unknown' }, 'Assistant turn failed')
      return reply.code(502).send({ error: 'The assistant had trouble responding. Please try again.' })
    }
  })

  // Owner/admin connection test: does a minimal live call and reports the exact
  // outcome (which model, or the precise provider error) so misconfiguration is
  // obvious without reading server logs.
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
