import type { FastifyInstance } from 'fastify'
import { and, desc, eq, gte } from 'drizzle-orm'
import {
  BUILT_IN_QUESTIONNAIRES,
  adherenceRate,
  labAliasForMetricType,
  labContextMatches,
  type AdherenceEvent,
} from '@medbot/shared'
import {
  evaluateTrends,
  mergedMetrics,
  mergedRedFlags,
  resolveModulesForConditions,
  type RedFlag,
  type TrackedMetric,
} from '@medbot/conditions'
import { db, schema } from '../db/index.js'
import { requireUser } from './auth.js'

const WEEK_DAYS = 7
const TREND_DAYS = 90

interface MetricRow {
  type: string
  value: string
  recordedAt: Date
  context: string | null
}

function metricLabel(m: TrackedMetric): string {
  if (m.type === 'lab_value' && m.contexts?.[0]) return m.contexts[0]
  if (m.type === 'a1c') return 'A1C'
  return m.type
}

function rowMatchesTracked(row: MetricRow, tracked: TrackedMetric): boolean {
  if (tracked.type === 'a1c') {
    const alias = labAliasForMetricType('a1c')
    return (
      row.type === 'a1c' ||
      (row.type === 'lab_value' && Boolean(alias) && labContextMatches(row.context, alias!))
    )
  }
  if (tracked.type === 'lab_value' && tracked.contexts?.[0]) {
    return row.type === 'lab_value' && labContextMatches(row.context, tracked.contexts[0])
  }
  return row.type === tracked.type
}

function rowMatchesFlag(row: MetricRow, flag: RedFlag): boolean {
  if (flag.metric === 'a1c') {
    const alias = labAliasForMetricType('a1c')
    return (
      row.type === 'a1c' ||
      (row.type === 'lab_value' && Boolean(alias) && labContextMatches(row.context, alias!))
    )
  }
  if (row.type !== flag.metric) return false
  if (flag.context) return labContextMatches(row.context, flag.context)
  return true
}

function inBand(value: number, min: number | null, max: number | null): boolean {
  return (min === null || value >= min) && (max === null || value <= max)
}

/**
 * On-demand 7-day digest: readings vs limits, firing patterns, threshold
 * crossings, adherence, and assessments. No background job — generated on read.
 */
export async function digestRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireUser)

  app.get('/digest', async (request, reply) => {
    const userId = request.session.userId!
    const now = new Date()
    const weekAgo = new Date(+now - WEEK_DAYS * 24 * 60 * 60 * 1000)
    const trendSince = new Date(+now - TREND_DAYS * 24 * 60 * 60 * 1000)

    const conditionRows = await db
      .select()
      .from(schema.conditions)
      .where(and(eq(schema.conditions.userId, userId), eq(schema.conditions.status, 'active')))

    const modules = resolveModulesForConditions(conditionRows)
    const tracked = mergedMetrics(modules)
    const flags = mergedRedFlags(modules)

    const metricRows = (await db
      .select({
        type: schema.metrics.type,
        value: schema.metrics.value,
        recordedAt: schema.metrics.recordedAt,
        context: schema.metrics.context,
      })
      .from(schema.metrics)
      .where(and(eq(schema.metrics.userId, userId), gte(schema.metrics.recordedAt, trendSince)))
      .orderBy(desc(schema.metrics.recordedAt))) as MetricRow[]

    const weekRows = metricRows.filter((r) => +r.recordedAt >= +weekAgo)

    const readings = tracked.map((m) => {
      const matched = weekRows.filter((r) => rowMatchesTracked(r, m))
      const values = matched.map((r) => Number(r.value)).filter((v) => Number.isFinite(v))
      const hasBand = m.targetMin !== null || m.targetMax !== null
      const inRange = hasBand
        ? values.filter((v) => inBand(v, m.targetMin, m.targetMax)).length
        : 0
      return {
        type: m.type,
        label: metricLabel(m),
        count: values.length,
        average: values.length
          ? Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(1))
          : null,
        inRangePct: hasBand && values.length ? Number((inRange / values.length).toFixed(3)) : null,
      }
    })

    const trendReadings = metricRows.map((r) => ({
      type: r.type,
      value: Number(r.value),
      recordedAt: r.recordedAt,
      context: r.context,
    }))
    const activePatterns = modules
      .flatMap((mod) =>
        evaluateTrends(mod.trends, trendReadings, now).map((t) => ({
          ...t,
          condition: mod.label,
        })),
      )
      .filter((t) => t.status === 'firing')

    const thresholdCrossings = flags
      .map((flag) => {
        const hits = weekRows.filter((row) => {
          if (!rowMatchesFlag(row, flag)) return false
          const v = Number(row.value)
          if (!Number.isFinite(v)) return false
          return flag.operator === 'lt' ? v < flag.threshold : v > flag.threshold
        })
        if (hits.length === 0) return null
        if (flag.occurrences > 1 && hits.length < flag.occurrences) return null
        return {
          id: flag.id,
          severity: flag.severity,
          message: flag.message,
          count: hits.length,
        }
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)

    const adherenceEvents = await db
      .select()
      .from(schema.adherenceEvents)
      .where(
        and(eq(schema.adherenceEvents.userId, userId), gte(schema.adherenceEvents.scheduledFor, weekAgo)),
      )

    const assessments = await db
      .select({
        questionnaireKey: schema.questionnaireResponses.questionnaireKey,
        score: schema.questionnaireResponses.score,
        band: schema.questionnaireResponses.band,
        completedAt: schema.questionnaireResponses.completedAt,
      })
      .from(schema.questionnaireResponses)
      .where(
        and(
          eq(schema.questionnaireResponses.userId, userId),
          gte(schema.questionnaireResponses.completedAt, weekAgo),
        ),
      )
      .orderBy(desc(schema.questionnaireResponses.completedAt))

    const flaggedLabs = await db
      .select({
        testName: schema.labResults.testName,
        value: schema.labResults.value,
        unit: schema.labResults.unit,
        flag: schema.labResults.flag,
      })
      .from(schema.labResults)
      .where(and(eq(schema.labResults.userId, userId), gte(schema.labResults.createdAt, weekAgo)))

    const notableLabs = flaggedLabs.filter((l) => l.flag && l.flag !== 'normal')
    const readingCount = readings.reduce((n, r) => n + r.count, 0)
    const rate = Number(adherenceRate(adherenceEvents as unknown as AdherenceEvent[]).toFixed(3))
    const missed = adherenceEvents.filter((e) => e.status === 'missed' || e.status === 'skipped').length

    const bullets: string[] = []
    if (readingCount === 0) bullets.push('No tracked readings were logged this week.')
    else {
      bullets.push(
        `${readingCount} tracked reading${readingCount === 1 ? '' : 's'} across ${readings.filter((r) => r.count > 0).length} metric${readings.filter((r) => r.count > 0).length === 1 ? '' : 's'}.`,
      )
      const ranged = readings.filter((r) => r.count > 0 && r.inRangePct !== null)
      if (ranged.length > 0) {
        bullets.push(
          ranged
            .map((r) => `${r.label} ${Math.round(r.inRangePct! * 100)}% in limits`)
            .join('; ') + '.',
        )
      }
    }
    for (const p of activePatterns) {
      bullets.push(`${p.description}${p.detail ? ` — ${p.detail}` : ''} (${p.condition})`)
    }
    for (const t of thresholdCrossings) {
      bullets.push(`${t.count}× ${t.severity}: ${t.message}`)
    }
    if (adherenceEvents.length > 0) {
      bullets.push(
        `Medication adherence ${Math.round(rate * 100)}% (${missed} missed of ${adherenceEvents.length}).`,
      )
    }
    for (const a of assessments) {
      const title = BUILT_IN_QUESTIONNAIRES[a.questionnaireKey]?.title ?? a.questionnaireKey
      bullets.push(`${title}${a.score !== null ? ` scored ${a.score}` : ''}${a.band ? ` (${a.band})` : ''}.`)
    }
    if (notableLabs.length > 0) {
      bullets.push(
        `${notableLabs.length} flagged lab result${notableLabs.length === 1 ? '' : 's'} this week.`,
      )
    }

    let headline = 'Quiet week — nothing crossed a limit.'
    if (readingCount === 0 && adherenceEvents.length === 0) headline = 'No readings or doses logged this week.'
    else if (activePatterns.length > 0) {
      headline = `${activePatterns.length} pattern${activePatterns.length === 1 ? '' : 's'} firing this week.`
    } else if (thresholdCrossings.length > 0) {
      headline = 'A module threshold was crossed this week.'
    } else if (readingCount > 0) {
      headline = `You logged ${readingCount} reading${readingCount === 1 ? '' : 's'} this week.`
    }

    return reply.send({
      generatedAt: now,
      windowDays: WEEK_DAYS,
      windowStart: weekAgo,
      windowEnd: now,
      headline,
      bullets,
      readings,
      activePatterns,
      thresholdCrossings,
      adherence: {
        rate,
        doses: adherenceEvents.length,
        missed,
      },
      assessments: assessments.map((a) => ({
        title: BUILT_IN_QUESTIONNAIRES[a.questionnaireKey]?.title ?? a.questionnaireKey,
        score: a.score,
        band: a.band,
        completedAt: a.completedAt,
      })),
    })
  })
}
