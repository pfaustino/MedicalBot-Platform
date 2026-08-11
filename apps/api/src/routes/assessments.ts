import type { FastifyInstance } from 'fastify'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import {
  BUILT_IN_QUESTIONNAIRES,
  inferModuleKey,
  scoreQuestionnaire,
  type ConditionKey,
} from '@medbot/shared'
import { modulesFor, mergedQuestionnaireKeys } from '@medbot/conditions'
import { db, schema } from '../db/index.js'
import { requireUser } from './auth.js'

/**
 * Questionnaire engine surface. Definitions are data (see @medbot/shared), so
 * this route just serves them, scores a submission, and stores the result both
 * as a questionnaire_response and as a questionnaire_score metric — the latter
 * is what lets a PHQ-9 trend on the same timeline as blood glucose (SPEC §5).
 */
export async function assessmentRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireUser)

  // What the user can take: every built-in instrument, flagged with whether the
  // user's conditions recommend it.
  app.get('/assessments/catalog', async (request, reply) => {
    const userId = request.session.userId!
    const conditionRows = await db
      .select({
        key: schema.conditions.key,
        displayName: schema.conditions.displayName,
        icdCode: schema.conditions.icdCode,
      })
      .from(schema.conditions)
      .where(and(eq(schema.conditions.userId, userId), eq(schema.conditions.status, 'active')))

    const recommended = new Set(
      mergedQuestionnaireKeys(
        modulesFor(
          conditionRows
            .map((c) => inferModuleKey(c))
            .filter((k): k is ConditionKey => k !== null),
        ),
      ),
    )

    return reply.send({
      instruments: Object.values(BUILT_IN_QUESTIONNAIRES).map((q) => ({
        key: q.key,
        title: q.title,
        description: q.description,
        cadenceDays: q.cadenceDays,
        questionCount: q.questions.length,
        recommended: recommended.has(q.key),
      })),
    })
  })

  // Full definition for the take-assessment screen.
  app.get('/assessments/:key', async (request, reply) => {
    const { key } = request.params as { key: string }
    const def = BUILT_IN_QUESTIONNAIRES[key]
    if (!def) return reply.code(404).send({ error: 'Unknown assessment' })
    return reply.send({ definition: def })
  })

  const submitBody = z.object({
    key: z.string().min(1),
    answers: z.record(z.string(), z.number()),
  })

  app.post('/assessments', async (request, reply) => {
    const parsed = submitBody.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid submission', issues: parsed.error.issues })
    }
    const def = BUILT_IN_QUESTIONNAIRES[parsed.data.key]
    if (!def) return reply.code(404).send({ error: 'Unknown assessment' })

    // Only score answers to questions the instrument actually defines.
    const validIds = new Set(def.questions.map((q) => q.id))
    const answers: Record<string, number> = {}
    for (const [id, value] of Object.entries(parsed.data.answers)) {
      if (validIds.has(id)) answers[id] = value
    }

    const result = scoreQuestionnaire(def, answers)
    const userId = request.session.userId!
    const now = new Date()

    await db.transaction(async (tx) => {
      await tx.insert(schema.questionnaireResponses).values({
        userId,
        questionnaireKey: def.key,
        answers,
        score: def.scoring === 'none' ? null : result.total,
        band: result.band?.label ?? null,
        criticalTriggered: result.criticalTriggered,
        completedAt: now,
      })

      // Store the score as a metric too, so it charts alongside everything else.
      if (def.scoring !== 'none') {
        await tx.insert(schema.metrics).values({
          userId,
          type: 'questionnaire_score',
          value: String(result.total),
          unit: 'points',
          recordedAt: now,
          source: 'questionnaire',
          context: def.key,
        })
      }
    })

    return reply.code(201).send({
      key: def.key,
      score: def.scoring === 'none' ? null : result.total,
      band: result.band,
      criticalTriggered: result.criticalTriggered,
    })
  })
}
