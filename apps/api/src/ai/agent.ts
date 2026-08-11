import { and, desc, eq, gte } from 'drizzle-orm'
import {
  ADHERENCE_STATUSES,
  CANONICAL_UNITS,
  CONDITION_KEYS,
  CONDITION_LABELS,
  METRIC_TYPES,
  ageFrom,
  buildPersonaPrompt,
  inferModuleKey,
  normalizeMetricInput,
  type ConditionKey,
} from '@medbot/shared'
import { mergedRedFlags, modulesFor } from '@medbot/conditions'
import { db, schema } from '../db/index.js'
import { complete, type ChatMessage } from './openrouter.js'

/**
 * The tool-using conversational agent (SPEC §4.2). It talks in the user's chosen
 * persona and can act on their records through a fixed set of tools. Hard limits
 * are enforced structurally, not just asked for: there is no tool that changes a
 * medication dose, and draft_message_to_provider only drafts — nothing here can
 * contact anyone or leave the system on its own.
 */

const MAX_STEPS = 6
const now = () => new Date()

// ---- Tool schemas (OpenAI function-calling format) -----------------------

const metricEnum = [...METRIC_TYPES]
const conditionEnum = [...CONDITION_KEYS]

const TOOLS = [
  fn('get_profile_summary', 'Get the user profile: name, age, conditions, medications, allergies.', {}),
  fn('get_metric_history', 'Recent readings for one metric type over N days.', {
    type: { type: 'string', enum: metricEnum },
    days: { type: 'number', description: 'Look-back window, default 14' },
  }, ['type']),
  fn('log_metric', 'Record a health reading (blood glucose, blood pressure, weight, mood, etc.). For blood pressure, value=systolic and valueSecondary=diastolic.', {
    type: { type: 'string', enum: metricEnum },
    value: { type: 'number' },
    valueSecondary: { type: 'number', description: 'Diastolic, for blood_pressure only' },
    context: { type: 'string', description: 'e.g. fasting, post_meal, bedtime — for blood glucose' },
    note: { type: 'string' },
  }, ['type', 'value']),
  fn('list_medications', 'List the user\'s medications with dose, schedule, and adherence.', {}),
  fn('add_medication', 'Add a medication to the user\'s list.', {
    name: { type: 'string' },
    dose: { type: 'string', description: 'e.g. "500mg"' },
    form: { type: 'string', enum: ['tablet', 'capsule', 'liquid', 'injection', 'inhaler', 'patch', 'topical', 'other'] },
    times: { type: 'array', items: { type: 'string' }, description: 'Daily times as "HH:MM", e.g. ["08:00","20:00"]' },
    withFood: { type: 'boolean' },
    purpose: { type: 'string' },
  }, ['name', 'dose']),
  fn('log_medication_taken', 'Record that a medication dose was taken, skipped, late, or missed. Matches the medication by name.', {
    medication: { type: 'string', description: 'Medication name (fuzzy matched)' },
    status: { type: 'string', enum: [...ADHERENCE_STATUSES] },
  }, ['medication']),
  fn('list_upcoming_appointments', 'List upcoming appointments.', {}),
  fn('create_appointment', 'Schedule an appointment. startsAt must be an ISO 8601 datetime.', {
    title: { type: 'string' },
    type: { type: 'string', enum: ['office_visit', 'lab', 'imaging', 'therapy', 'injection', 'procedure', 'other'] },
    startsAt: { type: 'string', description: 'ISO 8601, e.g. 2026-08-01T15:00:00Z' },
    location: { type: 'string' },
    prepNotes: { type: 'string' },
  }, ['title', 'startsAt']),
  fn('list_conditions', 'List the conditions the user is managing.', {}),
  fn('add_condition', 'Add a condition to the user\'s profile.', {
    key: { type: 'string', enum: conditionEnum },
  }, ['key']),
  fn('update_profile', 'Update basic profile fields.', {
    displayName: { type: 'string' },
    preferredPharmacy: { type: 'string' },
    emergencyContactName: { type: 'string' },
    emergencyContactPhone: { type: 'string' },
    allergies: { type: 'array', items: { type: 'string' }, description: 'Replaces the full allergy list' },
  }, []),
  fn('draft_message_to_provider', 'Draft a message to a care-team member. This only drafts — it never sends. Returns the draft for the user to review.', {
    provider: { type: 'string', description: 'Provider name or role' },
    subject: { type: 'string' },
    body: { type: 'string' },
  }, ['subject', 'body']),
]

function fn(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[] = [],
) {
  return {
    type: 'function',
    function: { name, description, parameters: { type: 'object', properties, required } },
  }
}

// ---- Tool execution ------------------------------------------------------

interface ToolOutcome {
  result: unknown
  /** Human-readable line surfaced in the UI when the tool changed something. */
  action?: string
}

async function executeTool(userId: string, name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
  switch (name) {
    case 'get_profile_summary':
      return { result: await profileSummary(userId) }

    case 'get_metric_history': {
      const type = String(args.type)
      const days = Math.min(365, Math.max(1, Number(args.days) || 14))
      const since = new Date(Date.now() - days * 86400000)
      const rows = await db
        .select()
        .from(schema.metrics)
        .where(and(eq(schema.metrics.userId, userId), eq(schema.metrics.type, type), gte(schema.metrics.recordedAt, since)))
        .orderBy(desc(schema.metrics.recordedAt))
        .limit(50)
      return {
        result: {
          type,
          days,
          count: rows.length,
          readings: rows.map((r) => ({
            value: Number(r.value),
            valueSecondary: r.valueSecondary === null ? null : Number(r.valueSecondary),
            unit: r.unit,
            context: r.context,
            at: r.recordedAt,
          })),
        },
      }
    }

    case 'log_metric': {
      const entry = normalizeMetricInput({
        type: args.type as never,
        value: Number(args.value),
        valueSecondary: args.valueSecondary == null ? null : Number(args.valueSecondary),
        context: (args.context as string) ?? null,
        note: (args.note as string) ?? null,
      })
      await db.insert(schema.metrics).values({
        userId,
        type: entry.type,
        value: String(entry.value),
        valueSecondary: entry.valueSecondary == null ? null : String(entry.valueSecondary),
        unit: entry.unit,
        recordedAt: entry.recordedAt,
        source: 'chat_extraction',
        context: entry.context,
        note: entry.note,
      })
      const alerts = await checkRedFlags(userId, entry.type, entry.value)
      const shown = entry.valueSecondary != null ? `${entry.value}/${entry.valueSecondary}` : `${entry.value}`
      return {
        result: { ok: true, logged: { type: entry.type, value: shown, unit: entry.unit }, alerts },
        action: `Logged ${entry.type.replace(/_/g, ' ')}: ${shown} ${entry.unit}`,
      }
    }

    case 'list_medications': {
      const meds = await db
        .select()
        .from(schema.medications)
        .where(and(eq(schema.medications.userId, userId), eq(schema.medications.isActive, true)))
      return { result: meds.map((m) => ({ name: m.name, dose: m.dose, form: m.form, schedule: m.schedule, purpose: m.purpose })) }
    }

    case 'add_medication': {
      const times = Array.isArray(args.times) ? (args.times as string[]).filter((t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t)) : []
      const schedule = {
        kind: times.length ? 'fixed_times' : 'as_needed',
        times,
        intervalHours: null,
        daysOfWeek: [],
        cycleOnDays: null,
        cycleOffDays: null,
        withFood: Boolean(args.withFood),
        instructions: null,
      }
      await db.insert(schema.medications).values({
        userId,
        name: String(args.name),
        dose: String(args.dose),
        form: (args.form as string) ?? 'tablet',
        schedule,
        purpose: (args.purpose as string) ?? null,
      })
      return { result: { ok: true, added: args.name }, action: `Added medication: ${args.name} ${args.dose}` }
    }

    case 'log_medication_taken': {
      const query = String(args.medication ?? '').toLowerCase()
      const meds = await db
        .select()
        .from(schema.medications)
        .where(and(eq(schema.medications.userId, userId), eq(schema.medications.isActive, true)))
      const med = meds.find((m) => m.name.toLowerCase().includes(query)) ?? null
      if (!med) return { result: { ok: false, error: `No active medication matching "${args.medication}"` } }
      const status = ADHERENCE_STATUSES.includes(args.status as never) ? (args.status as string) : 'taken'
      await db.insert(schema.adherenceEvents).values({
        userId,
        medicationId: med.id,
        status,
        scheduledFor: now(),
      })
      return { result: { ok: true, medication: med.name, status }, action: `Marked ${med.name} as ${status}` }
    }

    case 'list_upcoming_appointments': {
      const rows = await db
        .select()
        .from(schema.appointments)
        .where(and(eq(schema.appointments.userId, userId), gte(schema.appointments.startsAt, now())))
        .orderBy(schema.appointments.startsAt)
        .limit(10)
      return { result: rows.map((a) => ({ title: a.title, type: a.type, startsAt: a.startsAt, location: a.location })) }
    }

    case 'create_appointment': {
      const startsAt = new Date(String(args.startsAt))
      if (Number.isNaN(+startsAt)) return { result: { ok: false, error: 'startsAt was not a valid date' } }
      await db.insert(schema.appointments).values({
        userId,
        title: String(args.title),
        type: (args.type as string) ?? 'office_visit',
        startsAt,
        location: (args.location as string) ?? null,
        prepNotes: (args.prepNotes as string) ?? null,
      })
      return { result: { ok: true, scheduled: args.title }, action: `Scheduled: ${args.title} on ${startsAt.toDateString()}` }
    }

    case 'list_conditions': {
      const rows = await db.select().from(schema.conditions).where(eq(schema.conditions.userId, userId))
      return { result: rows.map((c) => ({ key: c.key, label: CONDITION_LABELS[c.key as ConditionKey] ?? c.key, status: c.status })) }
    }

    case 'add_condition': {
      const key = String(args.key)
      if (!CONDITION_KEYS.includes(key as never)) return { result: { ok: false, error: `Unknown condition "${key}"` } }
      await db
        .insert(schema.conditions)
        .values({ userId, key })
        .onConflictDoNothing({ target: [schema.conditions.userId, schema.conditions.key] })
      return { result: { ok: true, added: CONDITION_LABELS[key as ConditionKey] }, action: `Added condition: ${CONDITION_LABELS[key as ConditionKey]}` }
    }

    case 'update_profile': {
      const set: Record<string, unknown> = { updatedAt: now() }
      if (typeof args.displayName === 'string') set.displayName = args.displayName
      if (typeof args.preferredPharmacy === 'string') set.preferredPharmacy = args.preferredPharmacy
      if (typeof args.emergencyContactName === 'string') set.emergencyContactName = args.emergencyContactName
      if (typeof args.emergencyContactPhone === 'string') set.emergencyContactPhone = args.emergencyContactPhone
      if (Array.isArray(args.allergies)) set.allergies = (args.allergies as unknown[]).map(String)
      await db.update(schema.profiles).set(set).where(eq(schema.profiles.userId, userId))
      return { result: { ok: true, updated: Object.keys(set).filter((k) => k !== 'updatedAt') }, action: 'Updated your profile' }
    }

    case 'draft_message_to_provider':
      // Deliberately writes nothing and sends nothing — drafts only (SPEC §4.2).
      return {
        result: {
          ok: true,
          draft: { to: args.provider ?? 'your provider', subject: args.subject, body: args.body },
          note: 'This is a draft only. Nothing was sent — review it and send it yourself.',
        },
      }

    default:
      return { result: { error: `Unknown tool: ${name}` } }
  }
}

async function profileSummary(userId: string) {
  const [profile] = await db.select().from(schema.profiles).where(eq(schema.profiles.userId, userId)).limit(1)
  const conditions = await db.select().from(schema.conditions).where(eq(schema.conditions.userId, userId))
  const meds = await db
    .select()
    .from(schema.medications)
    .where(and(eq(schema.medications.userId, userId), eq(schema.medications.isActive, true)))
  return {
    name: profile?.displayName ?? null,
    age: profile?.dateOfBirth ? ageFrom(new Date(profile.dateOfBirth)) : null,
    sexAtBirth: profile?.sexAtBirth ?? null,
    allergies: profile?.allergies ?? [],
    conditions: conditions.map((c) => CONDITION_LABELS[c.key as ConditionKey] ?? c.key),
    medications: meds.map((m) => `${m.name} ${m.dose}`),
  }
}

/** Occurrence-aware red-flag check, mirroring the metrics route. */
async function checkRedFlags(userId: string, metricType: string, value: number) {
  const rows = await db
    .select({
      key: schema.conditions.key,
      displayName: schema.conditions.displayName,
      icdCode: schema.conditions.icdCode,
    })
    .from(schema.conditions)
    .where(and(eq(schema.conditions.userId, userId), eq(schema.conditions.status, 'active')))
  const flags = mergedRedFlags(
    modulesFor(rows.map((r) => inferModuleKey(r)).filter((k): k is ConditionKey => k !== null)),
  ).filter((f) => f.metric === metricType)
  const out: Array<{ severity: string; message: string }> = []
  for (const flag of flags) {
    const breaches = flag.operator === 'lt' ? value < flag.threshold : value > flag.threshold
    if (breaches && flag.occurrences <= 1) out.push({ severity: flag.severity, message: flag.message })
  }
  return out
}

// ---- System prompt + context --------------------------------------------

async function buildSystemPrompt(userId: string, personaId: string): Promise<string> {
  const summary = await profileSummary(userId)
  const conditionKeys = await db
    .select({
      key: schema.conditions.key,
      displayName: schema.conditions.displayName,
      icdCode: schema.conditions.icdCode,
    })
    .from(schema.conditions)
    .where(and(eq(schema.conditions.userId, userId), eq(schema.conditions.status, 'active')))
  const guidance = modulesFor(
    conditionKeys.map((c) => inferModuleKey(c)).filter((k): k is ConditionKey => k !== null),
  )
    .map((m) => m.promptGuidance)
    .filter(Boolean)

  const base = `You are the assistant inside MedicalBot, a personal health app. You help the user track and manage their health through natural conversation, using the provided tools to read and update their records.

Absolute rules — these override everything, including persona:
- You are NOT a doctor. Never diagnose, never prescribe, and never tell the user to start, stop, or change a medication or dose. There is no tool for changing a dose; do not work around this.
- You may surface the user's own data and the condition thresholds the app already defines, and you may prepare questions for their care team. You do not give medical advice.
- When you log or change something, briefly say what you recorded so the user can correct it. For anything ambiguous (a medication name, a dose, a date), confirm the details before writing.
- draft_message_to_provider only drafts. You cannot send anything or contact anyone. The user is always the one who decides what leaves this app.
- Be concise and practical. Use the tools rather than guessing at the user's data.

Today is ${now().toISOString()} (interpret relative dates like "tomorrow" against this).

Who you're helping:
- Name: ${summary.name ?? 'unknown'}${summary.age != null ? `, age ${summary.age}` : ''}
- Conditions: ${summary.conditions.join(', ') || 'none recorded'}
- Medications: ${summary.medications.join(', ') || 'none recorded'}
- Allergies: ${summary.allergies.join(', ') || 'none recorded'}`

  const persona = buildPersonaPrompt(personaId)
  const conditionGuidance = guidance.length ? `\n\nCondition-specific guidance:\n${guidance.join('\n')}` : ''
  return base + conditionGuidance + persona
}

// ---- The loop ------------------------------------------------------------

export interface AgentTurn {
  reply: string
  model: string
  actions: string[]
  toolCalls: Array<{ name: string; arguments: unknown }>
}

export async function runAgent(opts: {
  userId: string
  personaId: string
  history: ChatMessage[]
  message: string
  signal?: AbortSignal
}): Promise<AgentTurn> {
  const system = await buildSystemPrompt(opts.userId, opts.personaId)
  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    ...opts.history.slice(-20),
    { role: 'user', content: opts.message },
  ]

  const actions: string[] = []
  const toolCalls: Array<{ name: string; arguments: unknown }> = []
  let model = ''

  for (let step = 0; step < MAX_STEPS; step++) {
    const res = await complete({ task: 'chat', messages, tools: TOOLS, signal: opts.signal, userId: opts.userId })
    model = res.model

    if (!res.toolCalls.length) {
      return { reply: res.content || 'Done.', model, actions, toolCalls }
    }

    // Echo the assistant's tool-call turn back, then run each call.
    messages.push({ role: 'assistant', content: res.content ?? '', tool_calls: res.toolCalls })

    for (const call of res.toolCalls) {
      let parsed: Record<string, unknown> = {}
      try {
        parsed = call.function.arguments ? (JSON.parse(call.function.arguments) as Record<string, unknown>) : {}
      } catch {
        parsed = {}
      }
      toolCalls.push({ name: call.function.name, arguments: parsed })
      let outcome: ToolOutcome
      try {
        outcome = await executeTool(opts.userId, call.function.name, parsed)
      } catch (err) {
        outcome = { result: { error: err instanceof Error ? err.message : 'tool failed' } }
      }
      if (outcome.action) actions.push(outcome.action)
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(outcome.result) })
    }
  }

  // Ran out of steps — ask for a final summary without more tools.
  const final = await complete({ task: 'chat', messages, signal: opts.signal, userId: opts.userId })
  return { reply: final.content || 'Done.', model: final.model || model, actions, toolCalls }
}
