import type { FastifyInstance } from 'fastify'
import { and, asc, count, desc, eq, gte, sql } from 'drizzle-orm'
import { adherenceRate, canonicalLabName, type AdherenceEvent } from '@medbot/shared'
import {
  conditionDisplayLabel,
  mergeConditionSearchWithNlm,
  searchConditionCatalog,
} from '@medbot/shared'
import { getModule, resolveModuleForCondition } from '@medbot/conditions'
import { db, schema } from '../db/index.js'
import {
  fetchOpenRouterModels,
  filterOpenRouterModels,
  OpenRouterModelsError,
  type ModelKind,
} from '../lib/openrouter-models.js'
import { getOpenRouterSettings, getOpenRouterSettingsView } from '../lib/openrouter-settings.js'
import { searchNlmIcd10 } from '../lib/nlm-icd10.js'
import { lookupMedlinePlus } from '../lib/medlineplus.js'
import { resolveIcdForCondition } from '../lib/align-condition-icd.js'
import { requireUser } from './auth.js'

/**
 * Read endpoints backing the browsable UI. Everything is scoped to the session
 * user — there is no route here that can return another account's records.
 */
export async function recordRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireUser)

  app.get('/profile', async (request, reply) => {
    const userId = request.session.userId!

    const [profile] = await db
      .select()
      .from(schema.profiles)
      .where(eq(schema.profiles.userId, userId))
      .limit(1)

    const team = await db
      .select()
      .from(schema.careTeam)
      .where(eq(schema.careTeam.userId, userId))
      .orderBy(asc(schema.careTeam.name))

    return reply.send({ profile: profile ?? null, careTeam: team })
  })

  app.get('/settings/ai', async (request, reply) => {
    const userId = request.session.userId!
    const ai = await getOpenRouterSettingsView(userId)
    return reply.send({ ai })
  })

  app.get('/settings/ai/models', async (request, reply) => {
    const userId = request.session.userId!
    const settings = await getOpenRouterSettings(userId)
    if (!settings.apiKey) {
      return reply.code(503).send({
        error:
          'OpenRouter API key is not configured. Add your key above to browse models, or ask an admin to set a server-wide key.',
      })
    }

    const q = String((request.query as { q?: string }).q ?? '')
    const kindRaw = String((request.query as { kind?: string }).kind ?? 'text')
    const kind: ModelKind =
      kindRaw === 'speech' || kindRaw === 'transcription' ? kindRaw : 'text'
    try {
      const all = await fetchOpenRouterModels(settings.apiKey, settings.baseUrl)
      const models = filterOpenRouterModels(all, q, kind)
      return reply.send({ models })
    } catch (err) {
      if (err instanceof OpenRouterModelsError) {
        return reply.code(502).send({ error: err.message })
      }
      throw err
    }
  })

  app.get('/conditions/search', async (request, reply) => {
    const q = String((request.query as { q?: string }).q ?? '')
    const local = searchConditionCatalog(q, 25)
    const nlm = await searchNlmIcd10(q, 20)
    const results = mergeConditionSearchWithNlm(local, nlm, 25).map((r) => ({
      ...r,
      hasModule: r.moduleKey ? getModule(r.moduleKey) !== null : false,
    }))
    return reply.send({ results })
  })

  app.get('/conditions/reference', async (request, reply) => {
    const code = String((request.query as { code?: string }).code ?? '')
      .trim()
      .toUpperCase()
    if (!/^[A-Z][0-9A-Z.]{2,15}$/.test(code)) {
      return reply.code(400).send({ error: 'A valid ICD-10-CM code is required.' })
    }
    try {
      const reference = await lookupMedlinePlus(code)
      return reply.send(reference)
    } catch {
      return reply.code(502).send({ error: 'Could not reach MedlinePlus Connect.' })
    }
  })

  app.get('/conditions', async (request, reply) => {
    const userId = request.session.userId!

    const rows = await db
      .select()
      .from(schema.conditions)
      .where(eq(schema.conditions.userId, userId))
      .orderBy(asc(schema.conditions.key))

    const aligned = []
    for (const row of rows) {
      if (row.icdCode?.trim() && row.displayName?.trim()) {
        aligned.push(row)
        continue
      }
      const resolved = await resolveIcdForCondition(row)
      if (!resolved) {
        aligned.push(row)
        continue
      }
      const [updated] = await db
        .update(schema.conditions)
        .set({ icdCode: resolved.icdCode, displayName: resolved.displayName })
        .where(eq(schema.conditions.id, row.id))
        .returning()
      aligned.push(updated ?? { ...row, ...resolved })
    }

    const recordedByType = await loadMetricRecordedByType(userId)

    return reply.send({
      conditions: aligned.map((row) => {
        const codeModule = resolveModuleForCondition({ ...row, moduleConfig: null })
        const mod = resolveModuleForCondition(row)
        const label = conditionDisplayLabel(row)
        return {
          id: row.id,
          key: row.key,
          displayName: row.displayName,
          icdCode: row.icdCode,
          diagnosedAt: row.diagnosedAt,
          status: row.status,
          notes: row.notes,
          label,
          summary: mod?.summary ?? null,
          hasModule: Boolean(mod),
          /** True when tracking comes from stored module_config (can be cleared). */
          isDynamicModule: Boolean(row.moduleConfig) && !codeModule,
          trackedMetrics: (mod?.metrics ?? []).map((m) => {
            const recorded = recordedByType.get(recordedKey(m.type, m.contexts?.[0]))
            const values7d = recorded?.values7d ?? []
            const inRange = values7d.filter(
              (v) =>
                (m.targetMin === null || v >= m.targetMin) &&
                (m.targetMax === null || v <= m.targetMax),
            ).length
            return {
              ...m,
              recorded: {
                count: recorded?.count ?? 0,
                latestValue: recorded?.latestValue ?? null,
                latestSecondary: recorded?.latestSecondary ?? null,
                latestAt: recorded?.latestAt ?? null,
                count7d: values7d.length,
                average7d: values7d.length
                  ? Number((values7d.reduce((a, b) => a + b, 0) / values7d.length).toFixed(1))
                  : null,
                inRange7d: values7d.length ? Number((inRange / values7d.length).toFixed(3)) : null,
              },
            }
          }),
          thresholds: mod?.redFlags ?? [],
          trends: mod?.trends ?? [],
        }
      }),
    })
  })

  app.get('/medications', async (request, reply) => {
    const userId = request.session.userId!
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)

    const meds = await db
      .select()
      .from(schema.medications)
      .where(eq(schema.medications.userId, userId))
      .orderBy(asc(schema.medications.name))

    const events = await db
      .select()
      .from(schema.adherenceEvents)
      .where(
        and(
          eq(schema.adherenceEvents.userId, userId),
          gte(schema.adherenceEvents.scheduledFor, since),
        ),
      )

    return reply.send({
      medications: meds.map((med) => {
        const mine = events.filter((e) => e.medicationId === med.id)
        return {
          ...med,
          adherence30d: Number(
            adherenceRate(mine as unknown as AdherenceEvent[]).toFixed(3),
          ),
          doseCount30d: mine.length,
          missed30d: mine.filter((e) => e.status === 'missed' || e.status === 'skipped').length,
          events30d: mine.map((e) => ({
            scheduledFor: e.scheduledFor,
            status: e.status,
          })),
        }
      }),
    })
  })

  app.get('/medications/:id/adherence', async (request, reply) => {
    const userId = request.session.userId!
    const { id } = request.params as { id: string }

    const rows = await db
      .select()
      .from(schema.adherenceEvents)
      .where(
        and(
          eq(schema.adherenceEvents.userId, userId),
          eq(schema.adherenceEvents.medicationId, id),
        ),
      )
      .orderBy(desc(schema.adherenceEvents.scheduledFor))
      .limit(200)

    return reply.send({ events: rows })
  })

  app.get('/appointments', async (request, reply) => {
    const userId = request.session.userId!

    const rows = await db
      .select()
      .from(schema.appointments)
      .where(eq(schema.appointments.userId, userId))
      .orderBy(desc(schema.appointments.startsAt))

    const team = await db
      .select({ id: schema.careTeam.id, name: schema.careTeam.name })
      .from(schema.careTeam)
      .where(eq(schema.careTeam.userId, userId))

    const now = new Date()
    const withProvider = rows.map((r) => ({
      ...r,
      providerName: team.find((t) => t.id === r.providerId)?.name ?? null,
    }))

    return reply.send({
      upcoming: withProvider.filter((r) => r.startsAt >= now).sort((a, b) => +a.startsAt - +b.startsAt),
      past: withProvider.filter((r) => r.startsAt < now),
    })
  })

  app.get('/todos', async (request, reply) => {
    const userId = request.session.userId!
    const rows = await db
      .select()
      .from(schema.todos)
      .where(eq(schema.todos.userId, userId))
      .orderBy(desc(schema.todos.createdAt))

    const statusRank = (s: string) => (s === 'open' ? 0 : s === 'done' ? 1 : 2)
    const todos = [...rows].sort((a, b) => {
      const byStatus = statusRank(a.status) - statusRank(b.status)
      if (byStatus !== 0) return byStatus
      const aDue = a.dueAt ? +a.dueAt : Number.POSITIVE_INFINITY
      const bDue = b.dueAt ? +b.dueAt : Number.POSITIVE_INFINITY
      if (aDue !== bDue) return aDue - bDue
      return +b.createdAt - +a.createdAt
    })

    return reply.send({ todos })
  })

  app.get('/questionnaires', async (request, reply) => {
    const userId = request.session.userId!

    const rows = await db
      .select()
      .from(schema.questionnaireResponses)
      .where(eq(schema.questionnaireResponses.userId, userId))
      .orderBy(desc(schema.questionnaireResponses.completedAt))

    const byKey = new Map<string, typeof rows>()
    for (const row of rows) {
      const list = byKey.get(row.questionnaireKey) ?? []
      list.push(row)
      byKey.set(row.questionnaireKey, list)
    }

    return reply.send({
      instruments: [...byKey.entries()].map(([key, responses]) => ({
        key,
        latest: responses[0] ?? null,
        history: responses
          .map((r) => ({ completedAt: r.completedAt, score: r.score, band: r.band }))
          .reverse(),
      })),
    })
  })
}

interface MetricRecorded {
  count: number
  latestValue: number | null
  latestSecondary: number | null
  latestAt: Date | null
  values7d: number[]
}

function recordedKey(type: string, context?: string | null): string {
  if (type === 'lab_value' && context?.trim()) {
    return `lab_value:${canonicalLabName(context)}`
  }
  return type
}

function emptyRecorded(): MetricRecorded {
  return {
    count: 0,
    latestValue: null,
    latestSecondary: null,
    latestAt: null,
    values7d: [],
  }
}

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[]
  if (result && typeof result === 'object' && 'rows' in result) {
    return (result as { rows: T[] }).rows
  }
  return []
}

/** Latest reading, counts, and last-7-day values. Lab values are keyed by analyte. */
async function loadMetricRecordedByType(userId: string): Promise<Map<string, MetricRecorded>> {
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)

  const [counts, weekRows, latestResult] = await Promise.all([
    db
      .select({
        type: schema.metrics.type,
        context: schema.metrics.context,
        n: count(),
      })
      .from(schema.metrics)
      .where(eq(schema.metrics.userId, userId))
      .groupBy(schema.metrics.type, schema.metrics.context),
    db
      .select({
        type: schema.metrics.type,
        context: schema.metrics.context,
        value: schema.metrics.value,
      })
      .from(schema.metrics)
      .where(and(eq(schema.metrics.userId, userId), gte(schema.metrics.recordedAt, weekAgo))),
    db.execute(sql`
      SELECT DISTINCT ON (type, context)
        type,
        context,
        value,
        value_secondary,
        recorded_at
      FROM metrics
      WHERE user_id = ${userId}
      ORDER BY type, context, recorded_at DESC
    `),
  ])

  const map = new Map<string, MetricRecorded>()

  function bucket(type: string, context: string | null | undefined): MetricRecorded {
    const key = recordedKey(type, context)
    const existing = map.get(key)
    if (existing) return existing
    const created = emptyRecorded()
    map.set(key, created)
    return created
  }

  for (const row of counts) {
    bucket(row.type, row.context).count += Number(row.n)
  }

  for (const row of rowsOf<{
    type: string
    context: string | null
    value: string | number
    value_secondary: string | number | null
    recorded_at: Date | string
  }>(latestResult)) {
    const existing = bucket(row.type, row.context)
    const at = row.recorded_at instanceof Date ? row.recorded_at : new Date(row.recorded_at)
    if (existing.latestAt && existing.latestAt >= at) continue
    existing.latestValue = Number(row.value)
    existing.latestSecondary =
      row.value_secondary === null || row.value_secondary === undefined
        ? null
        : Number(row.value_secondary)
    existing.latestAt = at
  }

  for (const row of weekRows) {
    bucket(row.type, row.context).values7d.push(Number(row.value))
  }

  return map
}
