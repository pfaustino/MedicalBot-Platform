import type { FastifyInstance } from 'fastify'
import { and, desc, eq, gte } from 'drizzle-orm'
import { adherenceRate, type AdherenceEvent } from '@medbot/shared'
import { mergedMetrics, resolveModulesForConditions } from '@medbot/conditions'
import { db, schema } from '../db/index.js'
import { requireUser } from './auth.js'

/**
 * One round trip for the landing view: who the user is, what they track, how
 * the last week looked, and what is coming up.
 */
export async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireUser)

  app.get('/dashboard', async (request, reply) => {
    const userId = request.session.userId!
    const now = new Date()
    const weekAgo = new Date(+now - 7 * 24 * 60 * 60 * 1000)
    const monthAgo = new Date(+now - 30 * 24 * 60 * 60 * 1000)

    const [profile] = await db
      .select({ displayName: schema.profiles.displayName })
      .from(schema.profiles)
      .where(eq(schema.profiles.userId, userId))
      .limit(1)

    const conditionRows = await db
      .select({
        key: schema.conditions.key,
        displayName: schema.conditions.displayName,
        icdCode: schema.conditions.icdCode,
        moduleConfig: schema.conditions.moduleConfig,
      })
      .from(schema.conditions)
      .where(and(eq(schema.conditions.userId, userId), eq(schema.conditions.status, 'active')))

    const modules = resolveModulesForConditions(conditionRows)
    const tracked = mergedMetrics(modules)

    const recent = await db
      .select()
      .from(schema.metrics)
      .where(and(eq(schema.metrics.userId, userId), gte(schema.metrics.recordedAt, weekAgo)))
      .orderBy(desc(schema.metrics.recordedAt))

    // A tile per tracked metric: latest reading, 7-day average, and how many of
    // those readings sat inside the target band.
    const tiles = tracked.map((t) => {
      const rows = recent.filter((r) => r.type === t.type)
      const values = rows.map((r) => Number(r.value))
      const latest = rows[0]
      const inRange = values.filter(
        (v) => (t.targetMin === null || v >= t.targetMin) && (t.targetMax === null || v <= t.targetMax),
      ).length

      return {
        type: t.type,
        targetMin: t.targetMin,
        targetMax: t.targetMax,
        latestValue: latest ? Number(latest.value) : null,
        latestSecondary: latest?.valueSecondary ? Number(latest.valueSecondary) : null,
        latestAt: latest?.recordedAt ?? null,
        latestContext: latest?.context ?? null,
        unit: latest?.unit ?? null,
        count7d: values.length,
        average7d: values.length
          ? Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(1))
          : null,
        inRange7d: values.length ? Number((inRange / values.length).toFixed(3)) : null,
      }
    })

    const adherenceEvents = await db
      .select()
      .from(schema.adherenceEvents)
      .where(
        and(
          eq(schema.adherenceEvents.userId, userId),
          gte(schema.adherenceEvents.scheduledFor, monthAgo),
        ),
      )

    const activeMeds = await db
      .select({ id: schema.medications.id, name: schema.medications.name })
      .from(schema.medications)
      .where(and(eq(schema.medications.userId, userId), eq(schema.medications.isActive, true)))

    const upcoming = await db
      .select()
      .from(schema.appointments)
      .where(and(eq(schema.appointments.userId, userId), gte(schema.appointments.startsAt, now)))
      .orderBy(schema.appointments.startsAt)
      .limit(3)

    return reply.send({
      displayName: profile?.displayName ?? 'there',
      conditions: modules.map((m) => ({ key: m.key, label: m.label })),
      tiles,
      adherence: {
        rate30d: Number(
          adherenceRate(adherenceEvents as unknown as AdherenceEvent[]).toFixed(3),
        ),
        doses30d: adherenceEvents.length,
        missed30d: adherenceEvents.filter(
          (e) => e.status === 'missed' || e.status === 'skipped',
        ).length,
        activeMedications: activeMeds.length,
      },
      upcomingAppointments: upcoming,
    })
  })
}
