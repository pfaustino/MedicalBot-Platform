import type { FastifyInstance } from 'fastify'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import {
  ADHERENCE_STATUSES,
  careTeamMemberSchema,
  conditionCreateSchema,
  conditionDisplayLabel,
  conditionSchema,
  medicationSchema,
  profileSchema,
  resolveConditionCreate,
  scheduleSchema,
  storedModuleConfigSchema,
} from '@medbot/shared'
import {
  lookupTemplateModuleConfig,
  resolveModuleForCondition,
} from '@medbot/conditions'
import { generateModuleConfig } from '../ai/generate-module-config.js'
import { openRouterUserMessage } from '../ai/openrouter.js'
import { db, schema } from '../db/index.js'
import {
  clearOpenRouterApiKey,
  isOpenRouterConfigured,
  saveOpenRouterSettings,
} from '../lib/openrouter-settings.js'
import { requireUser } from './auth.js'

/**
 * Write endpoints backing the interactive UI. Everything is scoped to the
 * session user — no route here can read or mutate another account's records.
 * Reads live in records.ts; this file is the mutation surface.
 */

/** `date` columns are YYYY-MM-DD strings, not timestamps. */
const toDateStr = (d: Date | null | undefined): string | null =>
  d ? d.toISOString().slice(0, 10) : null

export async function manageRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireUser)

  // ---- Profile -----------------------------------------------------------

  const profileUpdate = profileSchema.partial()

  app.patch('/profile', async (request, reply) => {
    const parsed = profileUpdate.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid profile', issues: parsed.error.issues })
    }
    const userId = request.session.userId!
    const p = parsed.data

    const set: Record<string, unknown> = { updatedAt: new Date() }
    if (p.displayName !== undefined) set.displayName = p.displayName
    if (p.dateOfBirth !== undefined) set.dateOfBirth = toDateStr(p.dateOfBirth)
    if (p.sexAtBirth !== undefined) set.sexAtBirth = p.sexAtBirth
    if (p.heightCm !== undefined) set.heightCm = p.heightCm === null ? null : String(p.heightCm)
    if (p.timezone !== undefined) set.timezone = p.timezone
    if (p.allergies !== undefined) set.allergies = p.allergies
    if (p.emergencyContactName !== undefined) set.emergencyContactName = p.emergencyContactName
    if (p.emergencyContactPhone !== undefined) set.emergencyContactPhone = p.emergencyContactPhone
    if (p.preferredPharmacy !== undefined) set.preferredPharmacy = p.preferredPharmacy

    await db.update(schema.profiles).set(set).where(eq(schema.profiles.userId, userId))
    return reply.send({ ok: true })
  })

  // ---- AI / OpenRouter settings ------------------------------------------

  const aiSettingsBody = z.object({
    apiKey: z.string().min(8).max(500).optional(),
    baseUrl: z.string().url().max(500).nullable().optional(),
    modelChat: z.string().min(1).max(200).nullable().optional(),
    modelExtract: z.string().min(1).max(200).nullable().optional(),
    modelAnalyze: z.string().min(1).max(200).nullable().optional(),
    modelVision: z.string().min(1).max(200).nullable().optional(),
  })

  app.put('/settings/ai', async (request, reply) => {
    const parsed = aiSettingsBody.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid AI settings', issues: parsed.error.issues })
    }
    const userId = request.session.userId!
    const b = parsed.data
    if (
      b.apiKey === undefined &&
      b.baseUrl === undefined &&
      b.modelChat === undefined &&
      b.modelExtract === undefined &&
      b.modelAnalyze === undefined &&
      b.modelVision === undefined
    ) {
      return reply.code(400).send({ error: 'Nothing to update' })
    }
    await saveOpenRouterSettings(userId, b)
    return reply.send({ ok: true })
  })

  app.delete('/settings/ai', async (request, reply) => {
    const userId = request.session.userId!
    await clearOpenRouterApiKey(userId)
    return reply.send({ ok: true })
  })

  // ---- Care team ---------------------------------------------------------

  app.post('/care-team', async (request, reply) => {
    const parsed = careTeamMemberSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid provider', issues: parsed.error.issues })
    }
    const userId = request.session.userId!
    const [row] = await db
      .insert(schema.careTeam)
      .values({ userId, ...parsed.data })
      .returning({ id: schema.careTeam.id })
    return reply.code(201).send({ id: row!.id })
  })

  app.delete('/care-team/:id', async (request, reply) => {
    const userId = request.session.userId!
    const { id } = request.params as { id: string }
    await db
      .delete(schema.careTeam)
      .where(and(eq(schema.careTeam.userId, userId), eq(schema.careTeam.id, id)))
    return reply.send({ ok: true })
  })

  // ---- Conditions --------------------------------------------------------

  app.post('/conditions', async (request, reply) => {
    const legacy = conditionSchema.safeParse(request.body)
    const created = conditionCreateSchema.safeParse(request.body)
    if (!legacy.success && !created.success) {
      return reply.code(400).send({
        error: 'Invalid condition',
        issues: created.error.issues,
      })
    }

    const userId = request.session.userId!
    const row = legacy.success
      ? {
          key: legacy.data.key,
          displayName: null as string | null,
          icdCode: null as string | null,
          diagnosedAt: legacy.data.diagnosedAt,
          status: legacy.data.status,
          managingProviderId: legacy.data.managingProviderId,
          notes: legacy.data.notes,
        }
      : resolveConditionCreate(created.data!)

    await db
      .insert(schema.conditions)
      .values({
        userId,
        key: row.key,
        displayName: row.displayName,
        icdCode: row.icdCode,
        diagnosedAt: toDateStr(row.diagnosedAt),
        status: row.status,
        managingProviderId: row.managingProviderId,
        notes: row.notes,
      })
      .onConflictDoUpdate({
        target: [schema.conditions.userId, schema.conditions.key],
        set: {
          status: row.status,
          diagnosedAt: toDateStr(row.diagnosedAt),
          notes: row.notes,
          displayName: row.displayName,
          icdCode: row.icdCode,
        },
      })
    return reply.code(201).send({ ok: true })
  })

  app.delete('/conditions/:key', async (request, reply) => {
    const userId = request.session.userId!
    const { key } = request.params as { key: string }
    await db
      .delete(schema.conditions)
      .where(and(eq(schema.conditions.userId, userId), eq(schema.conditions.key, key)))
    return reply.send({ ok: true })
  })

  const moduleActionSchema = z.discriminatedUnion('action', [
    z.object({ action: z.literal('preview') }),
    z.object({
      action: z.literal('confirm'),
      config: storedModuleConfigSchema,
      targetRationale: z.string().max(400).optional(),
    }),
  ])

  /**
   * Preview or confirm a dynamic tracking module for a condition without a
   * code module. Preview never persists. Confirm validates and writes
   * module_config (overwrites prior dynamic config after successful generation).
   * Unmatched diagnoses use OpenRouter — no unrelated generic templates.
   */
  app.post('/conditions/:key/module', async (request, reply) => {
    const userId = request.session.userId!
    const { key } = request.params as { key: string }

    const [row] = await db
      .select()
      .from(schema.conditions)
      .where(and(eq(schema.conditions.userId, userId), eq(schema.conditions.key, key)))
      .limit(1)

    if (!row) {
      return reply.code(404).send({ error: 'Condition not found' })
    }

    const codeModule = resolveModuleForCondition({ ...row, moduleConfig: null })
    if (codeModule) {
      return reply.send({
        ok: true,
        alreadyActive: true,
        source: 'code',
        module: codeModule,
      })
    }

    const parsed = moduleActionSchema.safeParse(request.body ?? { action: 'preview' })
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid module request', issues: parsed.error.issues })
    }

    const label = conditionDisplayLabel({
      key: row.key,
      displayName: row.displayName,
    })

    if (parsed.data.action === 'preview') {
      const template = lookupTemplateModuleConfig({
        key: row.key,
        displayName: row.displayName,
        icdCode: row.icdCode,
        label,
      })

      if (template) {
        return reply.send({
          ok: true,
          preview: true,
          source: 'template',
          label,
          config: template,
          targetRationale: template.summary,
          metricTypes: template.metrics.map((m) => m.type),
        })
      }

      if (!(await isOpenRouterConfigured(userId))) {
        return reply.code(503).send({
          error:
            'Add your OpenRouter API key in Settings to generate a tracking module for this condition.',
          configured: false,
        })
      }

      try {
        const proposal = await generateModuleConfig({
          userId,
          key: row.key,
          displayName: row.displayName,
          icdCode: row.icdCode,
        })
        return reply.send({
          ok: true,
          preview: true,
          source: 'ai',
          label,
          config: proposal.config,
          targetRationale: proposal.targetRationale,
          metricTypes: proposal.config.metrics.map((m) => m.type),
        })
      } catch (err) {
        request.log.error(
          { err: err instanceof Error ? err.message : 'unknown' },
          'Module config generation failed',
        )
        const message =
          openRouterUserMessage(err) ??
          (err instanceof Error && err.message === 'Model did not return valid JSON'
            ? 'Could not generate a tracking module for this condition. Try again.'
            : err instanceof Error &&
                err.message === 'Model returned a module config that failed validation'
              ? 'Could not generate a valid tracking module for this condition. Try again.'
              : 'Could not generate a tracking module for this condition. Try again.')
        return reply.code(502).send({ error: message })
      }
    }

    // confirm — persist only the client-confirmed, re-validated config
    const config = storedModuleConfigSchema.parse({
      ...parsed.data.config,
      label: parsed.data.config.label?.trim() || label,
    })

    await db
      .update(schema.conditions)
      .set({ moduleConfig: config })
      .where(and(eq(schema.conditions.userId, userId), eq(schema.conditions.key, key)))

    return reply.code(201).send({
      ok: true,
      module: resolveModuleForCondition({ ...row, moduleConfig: config }),
    })
  })

  /** Clear a stored dynamic module_config (does not remove the condition). */
  app.delete('/conditions/:key/module', async (request, reply) => {
    const userId = request.session.userId!
    const { key } = request.params as { key: string }

    const [row] = await db
      .select()
      .from(schema.conditions)
      .where(and(eq(schema.conditions.userId, userId), eq(schema.conditions.key, key)))
      .limit(1)

    if (!row) {
      return reply.code(404).send({ error: 'Condition not found' })
    }

    const codeModule = resolveModuleForCondition({ ...row, moduleConfig: null })
    if (codeModule) {
      return reply.code(400).send({
        error: 'Built-in modules cannot be removed. Remove the condition instead.',
      })
    }

    await db
      .update(schema.conditions)
      .set({ moduleConfig: null })
      .where(and(eq(schema.conditions.userId, userId), eq(schema.conditions.key, key)))

    return reply.send({ ok: true })
  })

  // ---- Medications -------------------------------------------------------

  app.post('/medications', async (request, reply) => {
    const parsed = medicationSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid medication', issues: parsed.error.issues })
    }
    const userId = request.session.userId!
    const m = parsed.data
    const [row] = await db
      .insert(schema.medications)
      .values({
        userId,
        name: m.name,
        rxcui: m.rxcui,
        dose: m.dose,
        form: m.form,
        schedule: m.schedule,
        purpose: m.purpose,
        prescriber: m.prescriber,
        pharmacy: m.pharmacy,
        startedAt: toDateStr(m.startedAt),
        endedAt: toDateStr(m.endedAt),
        refillsRemaining: m.refillsRemaining,
        isActive: m.isActive,
      })
      .returning({ id: schema.medications.id })
    return reply.code(201).send({ id: row!.id })
  })

  const medicationPatch = z.object({
    isActive: z.boolean().optional(),
    refillsRemaining: z.number().int().min(0).nullable().optional(),
    pharmacy: z.string().max(200).nullable().optional(),
    prescriber: z.string().max(200).nullable().optional(),
    dose: z.string().min(1).max(100).optional(),
    purpose: z.string().max(300).nullable().optional(),
    schedule: scheduleSchema.optional(),
    endedAt: z.coerce.date().nullable().optional(),
  })

  app.patch('/medications/:id', async (request, reply) => {
    const parsed = medicationPatch.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid update', issues: parsed.error.issues })
    }
    const userId = request.session.userId!
    const { id } = request.params as { id: string }
    const u = parsed.data

    const set: Record<string, unknown> = {}
    if (u.isActive !== undefined) set.isActive = u.isActive
    if (u.refillsRemaining !== undefined) set.refillsRemaining = u.refillsRemaining
    if (u.pharmacy !== undefined) set.pharmacy = u.pharmacy
    if (u.prescriber !== undefined) set.prescriber = u.prescriber
    if (u.dose !== undefined) set.dose = u.dose
    if (u.purpose !== undefined) set.purpose = u.purpose
    if (u.schedule !== undefined) set.schedule = u.schedule
    if (u.endedAt !== undefined) set.endedAt = toDateStr(u.endedAt)

    if (Object.keys(set).length === 0) return reply.send({ ok: true })

    await db
      .update(schema.medications)
      .set(set)
      .where(and(eq(schema.medications.userId, userId), eq(schema.medications.id, id)))
    return reply.send({ ok: true })
  })

  const adherenceBody = z.object({
    status: z.enum(ADHERENCE_STATUSES),
    scheduledFor: z.coerce.date().default(() => new Date()),
    reason: z.string().max(500).nullable().default(null),
  })

  app.post('/medications/:id/adherence', async (request, reply) => {
    const parsed = adherenceBody.safeParse(request.body ?? {})
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid adherence', issues: parsed.error.issues })
    }
    const userId = request.session.userId!
    const { id } = request.params as { id: string }

    // Confirm the med belongs to this user before writing an event against it.
    const [med] = await db
      .select({ id: schema.medications.id })
      .from(schema.medications)
      .where(and(eq(schema.medications.userId, userId), eq(schema.medications.id, id)))
      .limit(1)
    if (!med) return reply.code(404).send({ error: 'Medication not found' })

    const { status, scheduledFor, reason } = parsed.data
    await db
      .insert(schema.adherenceEvents)
      .values({ userId, medicationId: id, status, scheduledFor, reason })
      // One event per dose slot — re-logging the same slot corrects it.
      .onConflictDoUpdate({
        target: [schema.adherenceEvents.medicationId, schema.adherenceEvents.scheduledFor],
        set: { status, reason, recordedAt: new Date() },
      })
    return reply.code(201).send({ ok: true })
  })

  // ---- Appointments ------------------------------------------------------

  const appointmentBody = z.object({
    title: z.string().min(1).max(200),
    type: z
      .enum(['office_visit', 'lab', 'imaging', 'therapy', 'injection', 'procedure', 'other'])
      .default('office_visit'),
    startsAt: z.coerce.date(),
    endsAt: z.coerce.date().nullable().default(null),
    location: z.string().max(300).nullable().default(null),
    providerId: z.string().uuid().nullable().default(null),
    prepNotes: z.string().max(2000).nullable().default(null),
  })

  app.post('/appointments', async (request, reply) => {
    const parsed = appointmentBody.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid appointment', issues: parsed.error.issues })
    }
    const userId = request.session.userId!
    const a = parsed.data
    const [row] = await db
      .insert(schema.appointments)
      .values({
        userId,
        title: a.title,
        type: a.type,
        startsAt: a.startsAt,
        endsAt: a.endsAt,
        location: a.location,
        providerId: a.providerId,
        prepNotes: a.prepNotes,
      })
      .returning({ id: schema.appointments.id })
    return reply.code(201).send({ id: row!.id })
  })

  const appointmentPatch = z.object({
    visitNotes: z.string().max(4000).nullable().optional(),
    prepNotes: z.string().max(2000).nullable().optional(),
    location: z.string().max(300).nullable().optional(),
  })

  app.patch('/appointments/:id', async (request, reply) => {
    const parsed = appointmentPatch.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid update', issues: parsed.error.issues })
    }
    const userId = request.session.userId!
    const { id } = request.params as { id: string }
    const set: Record<string, unknown> = {}
    if (parsed.data.visitNotes !== undefined) set.visitNotes = parsed.data.visitNotes
    if (parsed.data.prepNotes !== undefined) set.prepNotes = parsed.data.prepNotes
    if (parsed.data.location !== undefined) set.location = parsed.data.location
    if (Object.keys(set).length === 0) return reply.send({ ok: true })

    await db
      .update(schema.appointments)
      .set(set)
      .where(and(eq(schema.appointments.userId, userId), eq(schema.appointments.id, id)))
    return reply.send({ ok: true })
  })
}
