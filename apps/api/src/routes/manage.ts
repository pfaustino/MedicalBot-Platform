import type { FastifyInstance } from 'fastify'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import {
  ADHERENCE_STATUSES,
  careTeamMemberSchema,
  conditionCreateSchema,
  conditionDisplayLabel,
  conditionRenameSchema,
  conditionSchema,
  medicationSchema,
  profileSchema,
  resolveConditionCreate,
  buildConditionKey,
  inferModuleKey,
  scheduleSchema,
  storedModuleConfigSchema,
  todoCreateSchema,
  todoPatchSchema,
} from '@medbot/shared'
import {
  lookupTemplateModuleConfig,
  resolveModuleForCondition,
} from '@medbot/conditions'
import { generateModuleConfig } from '../ai/generate-module-config.js'
import { OpenRouterError, openRouterUserMessage } from '../ai/openrouter.js'
import { db, schema } from '../db/index.js'
import {
  createGoogleCalendarEvent,
  deleteGoogleCalendarEvent,
  updateGoogleCalendarEvent,
} from '../lib/google.js'
import { syncMedicationReminders } from '../lib/med-reminders.js'
import {
  clearOpenRouterApiKey,
  isOpenRouterConfigured,
  saveOpenRouterSettings,
} from '../lib/openrouter-settings.js'
import { requireUser } from './auth.js'
import { resolveIcdForCondition } from '../lib/align-condition-icd.js'

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
    modelTts: z.string().min(1).max(200).nullable().optional(),
    modelStt: z.string().min(1).max(200).nullable().optional(),
    ttsVoice: z.string().min(1).max(60).nullable().optional(),
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
      b.modelVision === undefined &&
      b.modelTts === undefined &&
      b.modelStt === undefined &&
      b.ttsVoice === undefined
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

  app.patch('/conditions/:key', async (request, reply) => {
    const parsed = conditionRenameSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid condition', issues: parsed.error.issues })
    }

    const userId = request.session.userId!
    const { key } = request.params as { key: string }
    const [existing] = await db
      .select()
      .from(schema.conditions)
      .where(and(eq(schema.conditions.userId, userId), eq(schema.conditions.key, key)))
      .limit(1)
    if (!existing) return reply.code(404).send({ error: 'Condition not found' })

    const resolved = resolveConditionCreate({
      name: parsed.data.name,
      moduleKey: parsed.data.moduleKey,
      icdCode: parsed.data.icdCode,
      status: 'active',
      diagnosedAt: null,
      managingProviderId: null,
      notes: null,
    })
    let nextKey = resolved.key
    let displayName = resolved.displayName
    let icdCode = resolved.icdCode

    if (!icdCode) {
      const aligned = await resolveIcdForCondition({
        key: nextKey,
        displayName,
        icdCode: null,
      })
      if (aligned) {
        icdCode = aligned.icdCode
        displayName = aligned.displayName
        const moduleKey = inferModuleKey({
          name: displayName,
          displayName,
          icdCode,
        })
        nextKey = buildConditionKey({ name: displayName, moduleKey, icdCode })
      }
    }

    if (nextKey !== key) {
      const [clash] = await db
        .select({ id: schema.conditions.id })
        .from(schema.conditions)
        .where(and(eq(schema.conditions.userId, userId), eq(schema.conditions.key, nextKey)))
        .limit(1)
      if (clash) {
        return reply.code(409).send({
          error: 'That diagnosis is already on your profile.',
        })
      }
    }

    const oldModule = inferModuleKey({
      key: existing.key,
      displayName: existing.displayName,
      icdCode: existing.icdCode,
    })
    const newModule = inferModuleKey({
      key: nextKey,
      displayName,
      icdCode,
    })
    const set: Record<string, unknown> = {
      key: nextKey,
      displayName,
      icdCode,
    }
    if (oldModule !== newModule) set.moduleConfig = null

    await db
      .update(schema.conditions)
      .set(set)
      .where(and(eq(schema.conditions.userId, userId), eq(schema.conditions.key, key)))

    return reply.send({ ok: true, key: nextKey, displayName, icdCode })
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
        const errMsg = err instanceof Error ? err.message : ''
        const message =
          (err instanceof OpenRouterError ? openRouterUserMessage(err) : null) ??
          (errMsg === 'Model did not return valid JSON' ||
          errMsg === 'Model did not return a JSON object'
            ? 'Could not generate a tracking module for this condition. Try again.'
            : errMsg.startsWith('Model returned a module config that failed validation')
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
    try {
      await syncMedicationReminders(userId, {
        id: row!.id,
        name: m.name,
        dose: m.dose,
        schedule: m.schedule,
        isActive: m.isActive,
        endedAt: toDateStr(m.endedAt),
        googleEventIds: {},
      })
    } catch (err) {
      request.log.warn({ err }, 'Could not sync medication reminders to Google Calendar')
    }
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

    const [existing] = await db
      .select()
      .from(schema.medications)
      .where(and(eq(schema.medications.userId, userId), eq(schema.medications.id, id)))
      .limit(1)
    if (!existing) return reply.code(404).send({ error: 'Not found' })

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

    try {
      await syncMedicationReminders(userId, {
        id: existing.id,
        name: existing.name,
        dose: typeof set.dose === 'string' ? set.dose : existing.dose,
        schedule: set.schedule ?? existing.schedule,
        isActive: typeof set.isActive === 'boolean' ? set.isActive : existing.isActive,
        endedAt:
          set.endedAt !== undefined ? (set.endedAt as string | null) : existing.endedAt,
        googleEventIds: existing.googleEventIds ?? {},
      })
    } catch (err) {
      request.log.warn({ err }, 'Could not sync medication reminders to Google Calendar')
    }
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
    /** Mirrors Google Calendar all-day events when syncing. */
    allDay: z.boolean().optional().default(false),
  })

  app.post('/appointments', async (request, reply) => {
    const parsed = appointmentBody.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid appointment', issues: parsed.error.issues })
    }
    const userId = request.session.userId!
    const a = parsed.data
    let googleEventId: string | null = null
    try {
      googleEventId = await createGoogleCalendarEvent(userId, {
        title: a.title,
        startsAt: a.startsAt,
        endsAt: a.endsAt,
        location: a.location,
        description: a.prepNotes,
        allDay: a.allDay,
      })
    } catch (err) {
      request.log.warn({ err }, 'Could not sync appointment to Google Calendar')
    }

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
        googleEventId,
      })
      .returning({ id: schema.appointments.id, googleEventId: schema.appointments.googleEventId })
    return reply.code(201).send({ id: row!.id, synced: Boolean(row!.googleEventId) })
  })

  const appointmentPatch = z.object({
    title: z.string().min(1).max(200).optional(),
    type: z
      .enum(['office_visit', 'lab', 'imaging', 'therapy', 'injection', 'procedure', 'other'])
      .optional(),
    startsAt: z.coerce.date().optional(),
    endsAt: z.coerce.date().nullable().optional(),
    location: z.string().max(300).nullable().optional(),
    prepNotes: z.string().max(2000).nullable().optional(),
    visitNotes: z.string().max(4000).nullable().optional(),
    allDay: z.boolean().optional(),
  })

  app.patch('/appointments/:id', async (request, reply) => {
    const parsed = appointmentPatch.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid update', issues: parsed.error.issues })
    }
    const userId = request.session.userId!
    const { id } = request.params as { id: string }
    const patch = parsed.data

    const [existing] = await db
      .select()
      .from(schema.appointments)
      .where(and(eq(schema.appointments.userId, userId), eq(schema.appointments.id, id)))
      .limit(1)
    if (!existing) return reply.code(404).send({ error: 'Appointment not found' })

    const set: Record<string, unknown> = {}
    if (patch.title !== undefined) set.title = patch.title
    if (patch.type !== undefined) set.type = patch.type
    if (patch.startsAt !== undefined) set.startsAt = patch.startsAt
    if (patch.endsAt !== undefined) set.endsAt = patch.endsAt
    if (patch.location !== undefined) set.location = patch.location
    if (patch.prepNotes !== undefined) set.prepNotes = patch.prepNotes
    if (patch.visitNotes !== undefined) set.visitNotes = patch.visitNotes

    if (Object.keys(set).length > 0) {
      await db
        .update(schema.appointments)
        .set(set)
        .where(and(eq(schema.appointments.userId, userId), eq(schema.appointments.id, id)))
    }

    const next = { ...existing, ...set }
    const startsAt = next.startsAt as Date
    const endsAt = (next.endsAt as Date | null) ?? null
    const allDay =
      patch.allDay ??
      (startsAt.getHours() === 0 &&
        startsAt.getMinutes() === 0 &&
        !!endsAt &&
        endsAt.getHours() === 0 &&
        endsAt.getMinutes() === 0 &&
        endsAt.getTime() - startsAt.getTime() >= 20 * 60 * 60 * 1000)

    let synced = Boolean(existing.googleEventId)
    if (existing.googleEventId) {
      try {
        await updateGoogleCalendarEvent(userId, existing.googleEventId, {
          title: String(next.title),
          startsAt,
          endsAt,
          location: (next.location as string | null) ?? null,
          description: (next.prepNotes as string | null) ?? null,
          allDay,
        })
        synced = true
      } catch (err) {
        request.log.warn({ err }, 'Could not update Google Calendar event')
      }
    }

    return reply.send({ ok: true, synced })
  })

  app.delete('/appointments/:id', async (request, reply) => {
    const userId = request.session.userId!
    const { id } = request.params as { id: string }
    const [existing] = await db
      .select({ googleEventId: schema.appointments.googleEventId })
      .from(schema.appointments)
      .where(and(eq(schema.appointments.userId, userId), eq(schema.appointments.id, id)))
      .limit(1)
    if (!existing) return reply.code(404).send({ error: 'Appointment not found' })

    if (existing.googleEventId) {
      try {
        await deleteGoogleCalendarEvent(userId, existing.googleEventId)
      } catch (err) {
        request.log.warn({ err }, 'Could not delete Google Calendar event')
      }
    }

    await db
      .delete(schema.appointments)
      .where(and(eq(schema.appointments.userId, userId), eq(schema.appointments.id, id)))
    return reply.send({ ok: true })
  })

  // ---- To-dos ------------------------------------------------------------

  app.post('/todos', async (request, reply) => {
    const parsed = todoCreateSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid to-do', issues: parsed.error.issues })
    }
    const userId = request.session.userId!
    const t = parsed.data
    const now = new Date()
    const [row] = await db
      .insert(schema.todos)
      .values({
        userId,
        title: t.title,
        notes: t.notes,
        dueAt: t.dueAt,
        status: t.status,
        source: 'manual',
        completedAt: t.status === 'done' ? now : null,
        updatedAt: now,
      })
      .returning({ id: schema.todos.id })
    return reply.code(201).send({ id: row!.id })
  })

  app.patch('/todos/:id', async (request, reply) => {
    const parsed = todoPatchSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid update', issues: parsed.error.issues })
    }
    const userId = request.session.userId!
    const { id } = request.params as { id: string }
    const patch = parsed.data
    if (Object.keys(patch).length === 0) return reply.send({ ok: true })

    const [existing] = await db
      .select()
      .from(schema.todos)
      .where(and(eq(schema.todos.userId, userId), eq(schema.todos.id, id)))
      .limit(1)
    if (!existing) return reply.code(404).send({ error: 'To-do not found' })

    const now = new Date()
    const nextStatus = patch.status ?? existing.status
    const set: Record<string, unknown> = { updatedAt: now }
    if (patch.title !== undefined) set.title = patch.title
    if (patch.notes !== undefined) set.notes = patch.notes
    if (patch.dueAt !== undefined) set.dueAt = patch.dueAt
    if (patch.status !== undefined) set.status = patch.status
    if (nextStatus === 'done' && existing.status !== 'done') {
      set.completedAt = now
    } else if (nextStatus !== 'done') {
      set.completedAt = null
    }

    await db
      .update(schema.todos)
      .set(set)
      .where(and(eq(schema.todos.userId, userId), eq(schema.todos.id, id)))
    return reply.send({ ok: true })
  })

  app.delete('/todos/:id', async (request, reply) => {
    const userId = request.session.userId!
    const { id } = request.params as { id: string }
    await db
      .delete(schema.todos)
      .where(and(eq(schema.todos.userId, userId), eq(schema.todos.id, id)))
    return reply.send({ ok: true })
  })
}
