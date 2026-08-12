import type { FastifyInstance } from 'fastify'
import { and, count, desc, eq, gte, max } from 'drizzle-orm'
import { z } from 'zod'
import { METRIC_TYPES, normalizeMetricInput } from '@medbot/shared'
import { mergedRedFlags, resolveModulesForConditions } from '@medbot/conditions'
import { db, schema } from '../db/index.js'
import { requireUser } from './auth.js'

const createBody = z.object({
  type: z.enum(METRIC_TYPES),
  value: z.number(),
  valueSecondary: z.number().nullish(),
  unit: z.string().optional(),
  recordedAt: z.coerce.date().optional(),
  context: z.string().max(120).nullish(),
  note: z.string().max(2000).nullish(),
  source: z.enum(['manual', 'chat_extraction', 'device_import', 'lab_upload', 'questionnaire'])
    .default('manual'),
})

const listQuery = z.object({
  type: z.enum(METRIC_TYPES).optional(),
  context: z.string().max(120).optional(),
  /** 0 = all time (no date filter). */
  days: z.coerce.number().int().min(0).max(3650).default(30),
  limit: z.coerce.number().int().min(1).max(2000).default(500),
})

export async function metricRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireUser)

  app.post('/metrics', async (request, reply) => {
    const parsed = createBody.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid metric', issues: parsed.error.issues })
    }

    const userId = request.session.userId!
    const entry = normalizeMetricInput({
      ...parsed.data,
      valueSecondary: parsed.data.valueSecondary ?? null,
      context: parsed.data.context ?? null,
      note: parsed.data.note ?? null,
    })

    const [row] = await db
      .insert(schema.metrics)
      .values({
        userId,
        type: entry.type,
        value: entry.value.toString(),
        valueSecondary: entry.valueSecondary?.toString() ?? null,
        unit: entry.unit,
        recordedAt: entry.recordedAt,
        source: entry.source,
        context: entry.context,
        note: entry.note,
      })
      .returning({ id: schema.metrics.id })

    const alerts = await checkRedFlags(userId, entry.type, entry.value)

    return reply.code(201).send({ id: row!.id, alerts })
  })

  // Distinct metric types this user has actually recorded, so the UI can offer
  // every one of them for viewing — nothing a user logs should be un-viewable.
  app.get('/metrics/types', async (request, reply) => {
    const userId = request.session.userId!
    const rows = await db
      .select({
        type: schema.metrics.type,
        n: count(),
        latest: max(schema.metrics.recordedAt),
      })
      .from(schema.metrics)
      .where(eq(schema.metrics.userId, userId))
      .groupBy(schema.metrics.type)

    return reply.send({
      types: rows.map((r) => ({ type: r.type, count: Number(r.n), latest: r.latest })),
    })
  })

  /** Distinct lab analytes (metrics.context) for charting one test at a time. */
  app.get('/metrics/lab-analytes', async (request, reply) => {
    const userId = request.session.userId!
    const rows = await db
      .select({
        name: schema.metrics.context,
        n: count(),
        latest: max(schema.metrics.recordedAt),
        unit: max(schema.metrics.unit),
      })
      .from(schema.metrics)
      .where(
        and(eq(schema.metrics.userId, userId), eq(schema.metrics.type, 'lab_value')),
      )
      .groupBy(schema.metrics.context)
      .orderBy(desc(count()))

    return reply.send({
      analytes: rows
        .filter((r) => r.name)
        .map((r) => ({
          name: r.name!,
          count: Number(r.n),
          latest: r.latest,
          unit: r.unit,
        })),
    })
  })

  /** Distinct episode names (symptom_severity.context) for charting one at a time. */
  app.get('/metrics/symptom-contexts', async (request, reply) => {
    const userId = request.session.userId!
    const rows = await db
      .select({
        name: schema.metrics.context,
        n: count(),
        latest: max(schema.metrics.recordedAt),
      })
      .from(schema.metrics)
      .where(
        and(eq(schema.metrics.userId, userId), eq(schema.metrics.type, 'symptom_severity')),
      )
      .groupBy(schema.metrics.context)
      .orderBy(desc(count()))

    return reply.send({
      symptoms: rows
        .filter((r) => r.name)
        .map((r) => ({
          name: r.name!,
          count: Number(r.n),
          latest: r.latest,
        })),
    })
  })

  app.get('/metrics', async (request, reply) => {
    const parsed = listQuery.safeParse(request.query)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid query', issues: parsed.error.issues })
    }

    const userId = request.session.userId!
    const { type, context, days, limit } = parsed.data

    const filters = [eq(schema.metrics.userId, userId)]
    if (days > 0) {
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
      filters.push(gte(schema.metrics.recordedAt, since))
    }
    if (type) filters.push(eq(schema.metrics.type, type))
    if (context) filters.push(eq(schema.metrics.context, context))

    const rows = await db
      .select()
      .from(schema.metrics)
      .where(and(...filters))
      .orderBy(desc(schema.metrics.recordedAt))
      .limit(limit)

    return reply.send({
      metrics: rows.map((r) => ({
        ...r,
        value: Number(r.value),
        valueSecondary: r.valueSecondary === null ? null : Number(r.valueSecondary),
      })),
    })
  })
}

/**
 * Evaluates the new reading against the red flags declared by the user's
 * condition modules. Occurrence-based flags count matching readings inside the
 * flag's window rather than firing on a single outlier.
 */
async function checkRedFlags(
  userId: string,
  metricType: string,
  value: number,
): Promise<Array<{ id: string; severity: string; message: string }>> {
  const userConditions = await db
    .select({
      key: schema.conditions.key,
      displayName: schema.conditions.displayName,
      icdCode: schema.conditions.icdCode,
      moduleConfig: schema.conditions.moduleConfig,
    })
    .from(schema.conditions)
    .where(and(eq(schema.conditions.userId, userId), eq(schema.conditions.status, 'active')))

  const modules = resolveModulesForConditions(userConditions)
  const flags = mergedRedFlags(modules).filter((f) => f.metric === metricType)
  if (flags.length === 0) return []

  const triggered: Array<{ id: string; severity: string; message: string }> = []

  for (const flag of flags) {
    const breaches = flag.operator === 'lt' ? value < flag.threshold : value > flag.threshold
    if (!breaches) continue

    if (flag.occurrences <= 1) {
      triggered.push({ id: flag.id, severity: flag.severity, message: flag.message })
      continue
    }

    const since = new Date(Date.now() - flag.windowHours * 60 * 60 * 1000)
    const recent = await db
      .select({ value: schema.metrics.value })
      .from(schema.metrics)
      .where(
        and(
          eq(schema.metrics.userId, userId),
          eq(schema.metrics.type, metricType),
          gte(schema.metrics.recordedAt, since),
        ),
      )

    const matching = recent.filter((r) => {
      const v = Number(r.value)
      return flag.operator === 'lt' ? v < flag.threshold : v > flag.threshold
    }).length

    if (matching >= flag.occurrences) {
      triggered.push({ id: flag.id, severity: flag.severity, message: flag.message })
    }
  }

  // Most severe first — the UI shows the top one prominently.
  const order = { emergency: 0, urgent: 1, notice: 2 } as const
  return triggered.sort(
    (a, b) =>
      order[a.severity as keyof typeof order] - order[b.severity as keyof typeof order],
  )
}
