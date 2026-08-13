import type { FastifyInstance } from 'fastify'
import { and, asc, desc, eq, gte } from 'drizzle-orm'
import {
  BUILT_IN_QUESTIONNAIRES,
  adherenceRate,
  conditionDisplayLabel,
  labAliasForMetricType,
  labContextMatches,
  type AdherenceEvent,
} from '@medbot/shared'
import {
  mergedMetrics,
  mergedRedFlags,
  resolveModulesForConditions,
  type RedFlag,
  type TrackedMetric,
} from '@medbot/conditions'
import { db, schema } from '../db/index.js'
import { requireUser } from './auth.js'

const WINDOW_DAYS = 90

interface MetricRow {
  type: string
  value: string
  valueSecondary: string | null
  unit: string
  recordedAt: Date
  context: string | null
}

function limitLabel(min: number | null, max: number | null): string | null {
  if (min !== null && max !== null) return `${min}–${max}`
  if (min !== null) return `Don't go below ${min}`
  if (max !== null) return `Keep below ${max}`
  return null
}

function inBand(value: number, min: number | null, max: number | null): boolean {
  return (min === null || value >= min) && (max === null || value <= max)
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
    const isA1c =
      row.type === 'a1c' ||
      (row.type === 'lab_value' && Boolean(alias) && labContextMatches(row.context, alias!))
    return isA1c
  }
  if (row.type !== flag.metric) return false
  if (flag.context) return labContextMatches(row.context, flag.context)
  return true
}

function summarizeTracked(tracked: TrackedMetric, rows: MetricRow[]) {
  const matched = rows.filter((r) => rowMatchesTracked(r, tracked))
  const values = matched.map((r) => Number(r.value)).filter((v) => Number.isFinite(v))
  const latest = matched[0]
  const hasBand = tracked.targetMin !== null || tracked.targetMax !== null
  const inRangeCount = hasBand ? values.filter((v) => inBand(v, tracked.targetMin, tracked.targetMax)).length : 0
  return {
    type: tracked.type,
    label: metricLabel(tracked),
    context: tracked.contexts?.[0] ?? null,
    limitLabel: limitLabel(tracked.targetMin, tracked.targetMax),
    targetMin: tracked.targetMin,
    targetMax: tracked.targetMax,
    count: values.length,
    latestValue: latest ? Number(latest.value) : null,
    latestSecondary: latest?.valueSecondary != null ? Number(latest.valueSecondary) : null,
    latestAt: latest?.recordedAt ?? null,
    unit: latest?.unit ?? null,
    average: values.length
      ? Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(1))
      : null,
    min: values.length ? Math.min(...values) : null,
    max: values.length ? Math.max(...values) : null,
    inRangePct: hasBand && values.length ? Number((inRangeCount / values.length).toFixed(3)) : null,
  }
}

/**
 * One payload for a printable 90-day visit packet: conditions, readings vs
 * limits, threshold crossings, meds, assessments, visits, and open questions.
 */
export async function visitPrepRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireUser)

  app.get('/visit-prep', async (request, reply) => {
    const userId = request.session.userId!
    const now = new Date()
    const since = new Date(+now - WINDOW_DAYS * 24 * 60 * 60 * 1000)

    const [profile] = await db
      .select({
        displayName: schema.profiles.displayName,
        dateOfBirth: schema.profiles.dateOfBirth,
        sexAtBirth: schema.profiles.sexAtBirth,
        allergies: schema.profiles.allergies,
        preferredPharmacy: schema.profiles.preferredPharmacy,
      })
      .from(schema.profiles)
      .where(eq(schema.profiles.userId, userId))
      .limit(1)

    const conditionRows = await db
      .select()
      .from(schema.conditions)
      .where(and(eq(schema.conditions.userId, userId), eq(schema.conditions.status, 'active')))
      .orderBy(asc(schema.conditions.key))

    const modules = resolveModulesForConditions(conditionRows)
    const tracked = mergedMetrics(modules)
    const flags = mergedRedFlags(modules)

    const careTeam = await db
      .select({
        name: schema.careTeam.name,
        role: schema.careTeam.role,
        organization: schema.careTeam.organization,
      })
      .from(schema.careTeam)
      .where(eq(schema.careTeam.userId, userId))
      .orderBy(asc(schema.careTeam.name))

    const metricRows = (await db
      .select({
        type: schema.metrics.type,
        value: schema.metrics.value,
        valueSecondary: schema.metrics.valueSecondary,
        unit: schema.metrics.unit,
        recordedAt: schema.metrics.recordedAt,
        context: schema.metrics.context,
      })
      .from(schema.metrics)
      .where(and(eq(schema.metrics.userId, userId), gte(schema.metrics.recordedAt, since)))
      .orderBy(desc(schema.metrics.recordedAt))) as MetricRow[]

    const meds = await db
      .select()
      .from(schema.medications)
      .where(and(eq(schema.medications.userId, userId), eq(schema.medications.isActive, true)))
      .orderBy(asc(schema.medications.name))

    const adherenceEvents = await db
      .select()
      .from(schema.adherenceEvents)
      .where(
        and(eq(schema.adherenceEvents.userId, userId), gte(schema.adherenceEvents.scheduledFor, since)),
      )

    const assessments = await db
      .select({
        questionnaireKey: schema.questionnaireResponses.questionnaireKey,
        score: schema.questionnaireResponses.score,
        band: schema.questionnaireResponses.band,
        completedAt: schema.questionnaireResponses.completedAt,
        criticalTriggered: schema.questionnaireResponses.criticalTriggered,
      })
      .from(schema.questionnaireResponses)
      .where(
        and(
          eq(schema.questionnaireResponses.userId, userId),
          gte(schema.questionnaireResponses.completedAt, since),
        ),
      )
      .orderBy(desc(schema.questionnaireResponses.completedAt))

    const appointments = await db
      .select({
        title: schema.appointments.title,
        type: schema.appointments.type,
        startsAt: schema.appointments.startsAt,
        location: schema.appointments.location,
        visitNotes: schema.appointments.visitNotes,
      })
      .from(schema.appointments)
      .where(and(eq(schema.appointments.userId, userId), gte(schema.appointments.startsAt, since)))
      .orderBy(asc(schema.appointments.startsAt))

    const upcoming = await db
      .select({
        title: schema.appointments.title,
        type: schema.appointments.type,
        startsAt: schema.appointments.startsAt,
        location: schema.appointments.location,
      })
      .from(schema.appointments)
      .where(and(eq(schema.appointments.userId, userId), gte(schema.appointments.startsAt, now)))
      .orderBy(asc(schema.appointments.startsAt))
      .limit(5)

    const openTodos = await db
      .select({
        title: schema.todos.title,
        notes: schema.todos.notes,
        dueAt: schema.todos.dueAt,
      })
      .from(schema.todos)
      .where(and(eq(schema.todos.userId, userId), eq(schema.todos.status, 'open')))
      .orderBy(asc(schema.todos.dueAt))

    const notableLabs = await db
      .select({
        testName: schema.labResults.testName,
        value: schema.labResults.value,
        unit: schema.labResults.unit,
        flag: schema.labResults.flag,
        collectedAt: schema.labResults.collectedAt,
      })
      .from(schema.labResults)
      .where(and(eq(schema.labResults.userId, userId), gte(schema.labResults.createdAt, since)))
      .orderBy(desc(schema.labResults.collectedAt))

    const imaging = await db
      .select({
        title: schema.imagingReports.title,
        modality: schema.imagingReports.modality,
        examAt: schema.imagingReports.examAt,
      })
      .from(schema.imagingReports)
      .where(eq(schema.imagingReports.userId, userId))
      .orderBy(desc(schema.imagingReports.examAt))
      .limit(10)

    const readings = tracked.map((m) => summarizeTracked(m, metricRows))

    const thresholdCrossings = flags
      .map((flag) => {
        const hits = metricRows.filter((row) => {
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
          latestAt: hits[0]?.recordedAt ?? null,
        }
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)

    const pastVisits = appointments.filter((a) => +a.startsAt < +now && +a.startsAt >= +since)

    return reply.send({
      generatedAt: now,
      windowDays: WINDOW_DAYS,
      windowStart: since,
      windowEnd: now,
      profile: profile ?? null,
      conditions: conditionRows.map((row) => ({
        key: row.key,
        label: conditionDisplayLabel(row),
        icdCode: row.icdCode,
        diagnosedAt: row.diagnosedAt,
        status: row.status,
      })),
      careTeam,
      readings,
      thresholdCrossings,
      medications: meds.map((med) => {
        const mine = adherenceEvents.filter((e) => e.medicationId === med.id)
        return {
          name: med.name,
          dose: med.dose,
          form: med.form,
          purpose: med.purpose,
          adherencePct: Number(adherenceRate(mine as unknown as AdherenceEvent[]).toFixed(3)),
          doseCount: mine.length,
          missed: mine.filter((e) => e.status === 'missed' || e.status === 'skipped').length,
        }
      }),
      assessments: assessments.map((a) => ({
        key: a.questionnaireKey,
        title: BUILT_IN_QUESTIONNAIRES[a.questionnaireKey]?.title ?? a.questionnaireKey,
        score: a.score,
        band: a.band,
        completedAt: a.completedAt,
        criticalTriggered: a.criticalTriggered,
      })),
      pastVisits,
      upcomingVisits: upcoming,
      questions: openTodos,
      notableLabs: notableLabs.filter((l) => l.flag && l.flag !== 'normal').slice(0, 20),
      imaging: imaging.filter((r) => !r.examAt || +r.examAt >= +since),
    })
  })
}
