import type { FastifyInstance } from 'fastify'
import { and, eq, inArray } from 'drizzle-orm'
import {
  CONDITION_ICD10,
  CONDITION_KEYS,
  CONDITION_LABELS,
  intakeSchema,
  type ConditionKey,
} from '@medbot/shared'
import { getModule } from '@medbot/conditions'
import { db, schema } from '../db/index.js'
import { requireUser } from './auth.js'

/**
 * Signup intake. The account already exists by the time we get here (Google
 * OAuth created it — see auth.ts); this is the short, mostly-optional step that
 * turns an empty account into a usable one by capturing at least one condition.
 * Completing it stamps `users.onboardedAt`, which is what the app gates on.
 */
export async function onboardingRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireUser)

  // Everything the intake screen needs: what we already know, what's selectable,
  // and whether the user has finished before (so a revisit pre-fills).
  app.get('/intake', async (request, reply) => {
    const userId = request.session.userId!

    const [user] = await db
      .select({ onboardedAt: schema.users.onboardedAt })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1)

    const [profile] = await db
      .select({
        displayName: schema.profiles.displayName,
        dateOfBirth: schema.profiles.dateOfBirth,
        sexAtBirth: schema.profiles.sexAtBirth,
      })
      .from(schema.profiles)
      .where(eq(schema.profiles.userId, userId))
      .limit(1)

    const conditionRows = await db
      .select({ key: schema.conditions.key })
      .from(schema.conditions)
      .where(eq(schema.conditions.userId, userId))

    return reply.send({
      onboardedAt: user?.onboardedAt ?? null,
      profile: profile ?? null,
      conditions: conditionRows.map((c) => c.key),
      // The picker offers every supported condition. `hasModule` flags the ones
      // that already track metrics and fire thresholds today, so the UI can hint
      // which selections make the dashboard light up immediately.
      conditionOptions: CONDITION_KEYS.map((key) => ({
        key,
        label: CONDITION_LABELS[key],
        hasModule: getModule(key) !== null,
      })),
    })
  })

  app.post('/intake', async (request, reply) => {
    const userId = request.session.userId!

    const parsed = intakeSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Invalid intake',
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      })
    }

    const { displayName, dateOfBirth, sexAtBirth, conditions } = parsed.data
    // The `date` column is a YYYY-MM-DD string, not a timestamp.
    const dob = dateOfBirth ? dateOfBirth.toISOString().slice(0, 10) : null

    const onboardedAt = await db.transaction(async (tx) => {
      await tx
        .insert(schema.profiles)
        .values({ userId, displayName, dateOfBirth: dob, sexAtBirth })
        .onConflictDoUpdate({
          target: schema.profiles.userId,
          set: { displayName, dateOfBirth: dob, sexAtBirth, updatedAt: new Date() },
        })

      // Reconcile the condition set to exactly what was submitted. Drop rows the
      // user cleared; add the new ones. Existing rows are left untouched so any
      // richer detail (diagnosis date, notes) added elsewhere survives a revisit.
      const existing = await tx
        .select({ key: schema.conditions.key })
        .from(schema.conditions)
        .where(eq(schema.conditions.userId, userId))

      const existingKeys = new Set(existing.map((e) => e.key as ConditionKey))
      const submitted = new Set(conditions)

      const toRemove = [...existingKeys].filter((k) => !submitted.has(k))
      if (toRemove.length > 0) {
        await tx
          .delete(schema.conditions)
          .where(
            and(eq(schema.conditions.userId, userId), inArray(schema.conditions.key, toRemove)),
          )
      }

      const toAdd = conditions.filter((k) => !existingKeys.has(k))
      if (toAdd.length > 0) {
        await tx.insert(schema.conditions).values(
          toAdd.map((key) => ({
            userId,
            key,
            icdCode: CONDITION_ICD10[key].code,
            displayName: CONDITION_ICD10[key].name,
          })),
        )
      }

      const now = new Date()
      const [row] = await tx
        .update(schema.users)
        .set({ onboardedAt: now, updatedAt: now })
        .where(eq(schema.users.id, userId))
        .returning({ onboardedAt: schema.users.onboardedAt })

      return row?.onboardedAt ?? now
    })

    return reply.send({ ok: true, onboardedAt })
  })
}
